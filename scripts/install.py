#!/usr/bin/env python3
"""Host-side GroupGuard installer. Python 3.9+, stdlib only; never run by TRSS."""
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

REPOSITORY = 'https://github.com/719083594/GroupGuard-Plugin.git'
ENVIRONMENT = {'GROUPGUARD_ADMIN_ENABLED': '1', 'GROUPGUARD_ADMIN_HOST': '0.0.0.0', 'GROUPGUARD_ADMIN_PORT': '15083'}
SOURCE = Path(__file__).resolve().parent.parent


class InstallError(Exception):
    pass


def require(condition, message):
    if not condition:
        raise InstallError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def run(args, cwd=None, timeout=30):
    # Compose output can contain credentials. Never copy stdout/stderr into errors.
    env = {k: v for k, v in os.environ.items() if not k.startswith('COMPOSE_')}
    env['GIT_TERMINAL_PROMPT'] = '0'
    try:
        result = subprocess.run([str(a) for a in args], cwd=cwd, env=env, capture_output=True, text=True, encoding='utf-8', timeout=timeout)
    except subprocess.TimeoutExpired:
        raise InstallError('命令超时，结果可能已经生效。请查看 data/install 中的记录并核对现状，不要连续重试。') from None
    except OSError:
        raise InstallError('无法执行 ' + str(args[0]) + '；请检查工具是否安装及当前用户权限。') from None
    require(result.returncode == 0, str(args[0]) + ' 执行失败；未输出可能含凭据的命令详情。请检查权限、Git 网络或 Compose 配置。')
    return result.stdout


def plain_file(file):
    require(not file.is_symlink() and file.is_file(), '文件不存在或是符号链接：' + str(file))
    return file.read_bytes()


def private_write(file, data, exclusive=False):
    require(not file.is_symlink(), '拒绝写入符号链接：' + str(file))
    file.parent.mkdir(parents=True, exist_ok=True)
    if exclusive:
        fd = os.open(str(file), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
        return
    fd, temporary = tempfile.mkstemp(prefix='.groupguard-', dir=str(file.parent))
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
        os.replace(temporary, file)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def is_trss(root):
    return (root / 'lib/plugins/plugin.js').is_file() and (root / 'lib/renderer/loader.js').is_file() and (root / 'package.json').is_file()


def discover(explicit=None, native=False):
    """Bounded search; no recursive filesystem scan and no secret output."""
    candidates, containers = {}, []
    if not native and shutil.which('docker'):
        try:
            ids = run(['docker', 'ps', '-q']).split()
            containers = json.loads(run(['docker', 'inspect', *ids])) if ids else []
        except InstallError:
            raise InstallError('无法读取 Docker。请使用原来有 Docker 权限的账号；若实际为普通安装，可显式添加 --native，避免将容器源码误当作普通安装。') from None
    for container in containers:
        for mount in container.get('Mounts', []):
            if mount.get('Type') != 'bind':
                continue
            root = Path(mount['Source']).resolve()
            if is_trss(root) and (not explicit or root == Path(explicit).resolve()):
                key = (str(root), container['Id'])
                candidates[key] = {'root': root, 'container': container, 'mount': mount}
    roots = [Path(explicit)] if explicit else [Path.cwd(), *list(Path.cwd().parents)[:3], Path('/opt/qqbot/yunzai'), Path('/opt/TRSS-Yunzai'), Path('/opt/Yunzai'), Path.home() / 'TRSS-Yunzai', Path.home() / 'Yunzai']
    docker_roots = {str(c['root']) for c in candidates.values()}
    for root in roots:
        root = root.resolve()
        if is_trss(root) and str(root) not in docker_roots:
            candidates[(str(root), '')] = {'root': root, 'container': None}
    return list(candidates.values())


def choose(candidates, container=None):
    all_candidates = candidates
    if container:
        candidates = [c for c in candidates if c['container'] and container in (c['container']['Id'], c['container']['Name'].lstrip('/'))]
    require(candidates, '未找到可识别的 TRSS。请在宿主机重试并加 --trss /实际的/TRSS目录；镜像内未挂载源码或 docker run 安装请按 docs/INSTALL.md 手动处理。')
    if len(candidates) == 1:
        selected = candidates[0]
        require(sum(c['root'] == selected['root'] for c in all_candidates) == 1, '多个运行容器共用同一 TRSS 源码目录，不能自动安装共用的可写插件数据；请使用独立挂载或手动核对。')
        return selected
    require(sys.stdin.isatty(), '发现多个机器人；请用 --container 容器名 或 --trss 目录明确选择，未修改任何机器人。')
    for i, item in enumerate(candidates, 1):
        print(str(i) + '. ' + str(item['root']) + (' [Docker: ' + item['container']['Name'].lstrip('/') + ']' if item['container'] else ' [普通安装]'))
    try:
        number = int(input('请选择机器人编号：'))
    except (ValueError, EOFError):
        raise InstallError('未选择有效机器人，已停止。') from None
    require(1 <= number <= len(candidates), '机器人编号无效。')
    selected = candidates[number - 1]
    require(sum(c['root'] == selected['root'] for c in all_candidates) == 1, '多个运行容器共用同一 TRSS 目录，请先核对数据隔离，未安装。')
    return selected


def ensure_plugin(root, source=SOURCE):
    target = root / 'plugins/GroupGuard-Plugin'
    require(not (root / 'plugins').is_symlink() and not target.is_symlink(), 'plugins 或群管目录是符号链接，请手动安装，未修改。')
    if target.exists():
        package = json.loads(plain_file(target / 'package.json'))
        require(package.get('name') == 'groupguard-plugin', '目标目录不是 GroupGuard，拒绝覆盖。')
        return target, False
    require(source.resolve() != target.resolve(), '安装源不完整。')
    # Copy a Git clone as one directory; local ZIP installation may also initialize itself.
    require(json.loads(plain_file(source / 'package.json')).get('name') == 'groupguard-plugin', '安装源不是群管。')
    if (source / '.git').exists():
        require(run(['git', '-C', source, 'remote', 'get-url', 'origin']).strip().removesuffix('.git') == REPOSITORY.removesuffix('.git'), '安装源不是官方仓库，已停止。')
        require(not run(['git', '-C', source, 'status', '--porcelain']).strip(), '安装源有本地修改，已停止复制；请使用官方干净克隆。')
        require(not run(['git', '-C', source, 'ls-files', 'config/local.json', 'data/']).strip(), '安装源跟踪了实例数据，已停止。')
    else:
        require(not (source / 'config/local.json').exists() and not (source / 'data').exists(), 'ZIP 安装源含实例数据；请直接在已安装目录运行安装工具，或使用干净发布包。')
    for directory, directories, files in os.walk(source, followlinks=False):
        directories[:] = [d for d in directories if d not in ('node_modules','.test-tmp','.reference','.verification','dist','__pycache__')]
        require(all(not (Path(directory)/name).is_symlink() for name in directories+files), '安装源含符号链接，请先核对，未复制。')
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix='.groupguard-install-', dir=str(target.parent)))
    try:
        shutil.copytree(source, temporary / 'plugin', ignore=shutil.ignore_patterns('baseline-files.txt', '__pycache__', '*.pyc', '.test-tmp', '.verification', '.reference', 'dist', 'node_modules'))
        require(not target.exists(), '目标目录在安装过程中出现，拒绝覆盖。')
        (temporary / 'plugin').rename(target)
    finally:
        require(temporary.resolve().parent == target.parent.resolve() and temporary.name.startswith('.groupguard-install-'), '临时安装目录不在预期位置，未清理。')
        shutil.rmtree(temporary)
    return target, True


def initialize(target, owner=None):
    for relative in ('config', 'data', 'data/install'):
        directory = target / relative
        require(not directory.is_symlink(), '配置或数据目录是符号链接，未修改。')
        existed = directory.exists()
        directory.mkdir(exist_ok=True)
        if not existed and owner is not None and os.name == 'posix':
            os.chown(directory, *owner)
    file = target / 'config/local.json'
    if not file.exists():
        private_write(file, plain_file(target / 'config/default.json'), exclusive=True)
        if owner is not None and os.name == 'posix':
            os.chown(file, *owner)
    config = json.loads(plain_file(file))
    require(isinstance(config, dict) and isinstance(config.get('masters', []), list), '原实例配置无法识别，已保留，请先修复。')
    return bool(config.get('masters'))


def runtime_owner(container, location):
    # The entrypoint may drop privileges; docker exec's default user need not be
    # the user running TRSS. Identify Node processes by cwd without printing argv.
    probe = '''const fs=require('node:fs'),path=require('node:path'),root=fs.realpathSync(process.argv[1]),owners=new Set();
for(const pid of fs.readdirSync('/proc').filter(x=>/^\\d+$/.test(x)&&Number(x)!==process.pid))try{
 if(fs.readlinkSync('/proc/'+pid+'/cwd')!==root||!/^node(?:js)?$/.test(path.basename(fs.readlinkSync('/proc/'+pid+'/exe'))))continue;
 const s=fs.readFileSync('/proc/'+pid+'/status','utf8'),uid=s.match(/^Uid:\\s+\\d+\\s+(\\d+)/m),gid=s.match(/^Gid:\\s+\\d+\\s+(\\d+)/m);
 if(uid&&gid)owners.add(uid[1]+':'+gid[1]);
}catch{}
if(owners.size!==1)process.exit(2);const [uid,gid]=[...owners][0].split(':').map(Number);
console.log(JSON.stringify({major:Number(process.versions.node.split('.')[0]),uid,gid}));'''
    value = json.loads(run(['docker', 'exec', container['Id'], 'node', '-e', probe, location]))
    require(value['major'] >= 20, '容器内 Node.js 低于 20，请先更新机器人运行环境。')
    def mapped(kind, value):
        file = Path('/proc') / str(container['State']['Pid']) / (kind + '_map')
        for line in plain_file(file).decode().splitlines():
            inside, outside, size = map(int, line.split())
            if inside <= value < inside + size:
                return outside + value - inside
        raise InstallError('无法确定容器用户与宿主机的对应关系，请手动安装。')
    return (mapped('uid', value['uid']), mapped('gid', value['gid'])), str(value['uid'])+':'+str(value['gid'])


def compose_context(item, env_files=()):
    container = item['container']
    labels = container['Config'].get('Labels') or {}
    project, service = labels.get('com.docker.compose.project'), labels.get('com.docker.compose.service')
    require(project and service, '此机器人不是 Docker Compose 管理；已停止自动配置，请按 docs/INSTALL.md 的 docker run 说明操作。')
    require(item['mount'].get('RW'), 'TRSS 源码挂载为只读，无法安装插件。')
    files = [Path(p) for p in labels.get('com.docker.compose.project.config_files', '').split(',') if p]
    require(files and all(p.is_absolute() for p in files), '无法定位原 Compose 文件，请按 docs/INSTALL.md 手动处理。')
    for file in files:
        plain_file(file)
    directory = Path(labels.get('com.docker.compose.project.working_dir') or files[0].parent)
    require(directory.is_dir(), '原 Compose 工作目录不可用。')
    selected_env = list(env_files) or [p for p in labels.get('com.docker.compose.project.environment_file', '').split(',') if p]
    env = [Path(p).resolve() for p in selected_env]
    if not env and (directory / '.env').exists():
        env = [directory / '.env']
    for file in env:
        plain_file(file)
    return {'project': project, 'service': service, 'files': files, 'directory': directory, 'env': env, 'container': container}


def compose_args(context, files=None):
    args = ['docker', 'compose', '--project-directory', str(context['directory']), '-p', context['project']]
    for file in context['env']:
        args.extend(['--env-file', str(file)])
    for file in files or context['files']:
        args.extend(['-f', str(file)])
    return args


def model(context, files=None):
    return json.loads(run(compose_args(context, files) + ['config', '--format', 'json']))


def same_except_admin(before, after, service, port):
    expected = copy.deepcopy(before)
    target = expected['services'][service]
    target.setdefault('environment', {}).update(ENVIRONMENT)
    mapping = {'target': 15083, 'published': str(port), 'host_ip': '127.0.0.1', 'protocol': 'tcp'}
    ports = target.setdefault('ports', [])
    if not any(p.get('target') == 15083 and str(p.get('published')) == str(port) and p.get('host_ip') == '127.0.0.1' and p.get('protocol', 'tcp') == 'tcp' for p in ports):
        # Compose adds mode: ingress when normalizing short port syntax.
        ports.append({**mapping, 'mode': 'ingress'})
    require(expected == after, 'Compose 校验发现目标端口和群管环境变量之外的变化，未应用；请使用手动配置说明。')


def patch_compose(text, service, port, add_port=True):
    """Conservative block-YAML patch, verified afterwards by Docker Compose itself.

    Keep interpolation, comments and unrelated keys. Complex YAML is refused,
    never converted to rendered JSON (which could freeze .env secrets).
    """
    lines = text.splitlines(keepends=True)
    newline = '\r\n' if '\r\n' in text else '\n'
    if lines and not lines[-1].endswith(('\r', '\n')):
        lines[-1] += newline
    services = [i for i, line in enumerate(lines) if re.fullmatch(r'services:\s*(?:#.*)?', line.rstrip())]
    require(len(services) == 1, 'Compose 不是可自动修改的块式 YAML；未改文件，请按 docs/INSTALL.md 手动配置。')
    top_end = next((i for i in range(services[0]+1, len(lines)) if re.match(r'^[^\s#]', lines[i])), len(lines))
    # A dependency can have the same key as the target service (depends_on).
    # Only direct children of services are service declarations.
    child_indents = [len(m[1]) for line in lines[services[0]+1:top_end] if (m := re.match(r'^( +)(?:[A-Za-z_][\w.-]*|"[^"\n]+"|\'[^\'\n]+\'):', line))]
    require(child_indents, 'Compose 中没有可识别的服务。')
    service_indent = min(child_indents)
    found = []
    for i in range(services[0]+1, top_end):
        match = re.fullmatch(r'([ ]+)(?:' + re.escape(service) + r'|"' + re.escape(service) + r'"|\'' + re.escape(service) + r'\'):\s*(?:#.*)?', lines[i].rstrip())
        if match and len(match[1]) == service_indent:
            found.append((i, len(match[1])))
    require(len(found) == 1, '不能唯一定位 Compose 服务块；请按 docs/INSTALL.md 手动配置。')
    start, indent = found[0]
    end = next((i for i in range(start+1, top_end) if lines[i].strip() and not lines[i].lstrip().startswith('#') and len(lines[i])-len(lines[i].lstrip(' ')) <= indent), top_end)
    fields = []
    for i in range(start+1, end):
        match = re.match(r'^( +)([A-Za-z_][\w-]*):', lines[i])
        if match:
            fields.append((i, len(match[1]), match[2]))
    require(fields, '服务块中没有可识别字段，已停止。')
    child = min(entry[1] for entry in fields)
    fields = [(i, key) for i, n, key in fields if n == child]
    edits = []
    additions = []
    for key in ('environment', 'ports'):
        if key == 'ports' and not add_port:
            continue
        occurrences = [(i, k) for i, k in fields if k == key]
        require(len(occurrences) <= 1, 'Compose 存在重复字段，已停止。')
        if not occurrences:
            if key == 'environment':
                additions.extend([' '*child+'environment:'+newline] + [' '*(child+2)+k+': '+json.dumps(v)+newline for k,v in ENVIRONMENT.items()])
            else:
                additions.extend([' '*child+'ports:'+newline, ' '*(child+2)+'- '+json.dumps('127.0.0.1:'+str(port)+':15083')+newline])
            continue
        begin = occurrences[0][0]
        finish = next((i for i, _ in fields if i > begin), end)
        require(re.fullmatch(r' *'+key+r':\s*(?:#.*)?', lines[begin].rstrip()), '环境变量或端口使用行内/锚点写法；未改文件，请按 docs/INSTALL.md 手动配置。')
        content = lines[begin+1:finish]
        entries = [line for line in content if line.strip() and not line.lstrip().startswith('#')]
        entry_indent = min([len(line)-len(line.lstrip(' ')) for line in entries] or [child+2])
        if key == 'ports':
            require(all(line.lstrip().startswith('-') or len(line)-len(line.lstrip(' ')) > entry_indent for line in entries), '端口列表不能安全自动修改。')
            content.append(' '*entry_indent+'- '+json.dumps('127.0.0.1:'+str(port)+':15083')+newline)
        else:
            list_style = bool(entries and entries[0].lstrip().startswith('-'))
            pattern = re.compile(r'^\s*(?:-\s*[\"\']?)?(?:'+'|'.join(ENVIRONMENT)+r')\s*[:=]')
            kept = [line for line in content if not pattern.match(line)]
            # Multiline/alias cases must fail the semantic comparison, never be guessed.
            content = kept + [(' '*entry_indent+'- '+json.dumps(k+'='+v) if list_style else ' '*entry_indent+k+': '+json.dumps(v))+newline for k,v in ENVIRONMENT.items()]
        edits.append((begin+1, finish, content))
    for begin, finish, content in sorted(edits, reverse=True):
        lines[begin:finish] = content
    # Add missing fields directly after service header so no trailing YAML document is crossed.
    lines[start+1:start+1] = additions
    return ''.join(lines)


def select_port(before, service, requested=None):
    ports = [p for p in before['services'][service].get('ports', []) if p.get('target') == 15083 and p.get('protocol', 'tcp') == 'tcp']
    require(len(ports) <= 1, '群管端口有多条映射，请先手动整理。')
    if ports:
        p = ports[0]
        require(p.get('host_ip') == '127.0.0.1' and str(p.get('published', '')).isdigit(), '现有群管端口不是固定的本机映射，请按手动说明调整。')
        require(requested is None or int(p['published']) == requested, '已存在不同的管理端口，保留原端口；请去掉 --port 重试。')
        return int(p['published']), True
    for port in ([requested] if requested else range(15083, 15104)):
        with socket.socket() as probe:
            try:
                probe.bind(('127.0.0.1', port))
                return port, False
            except OSError:
                pass
    raise InstallError('管理端口被占用，请用 --port 指定一个空闲的宿主机端口。')


def prepare_compose(context, target, requested=None):
    before = model(context)
    service = context['service']
    require(service in before.get('services', {}), 'Compose 中找不到运行中的机器人服务。')
    # Refuse unrelated pending edits, wrong .env, or different invocation options.
    expected_hash = (context['container']['Config'].get('Labels') or {}).get('com.docker.compose.config-hash')
    actual_hash = run(compose_args(context)+['config', '--hash', service]).strip().split()
    require(expected_hash and actual_hash and actual_hash[-1] == expected_hash, '当前 Compose/.env 与运行中的容器不一致。请先处理原有改动，或用 --env-file 指定原环境文件；未重启机器人。')
    require(before['services'][service].get('network_mode') != 'host', 'host 网络模式请按普通安装的本机监听方式配置，未更改。')
    port, mapped = select_port(before, service, requested)
    environment = before['services'][service].get('environment', {})
    require(str(environment.get('GROUPGUARD_ADMIN_PORT', '15083')) == '15083', '原插件使用自定义容器内管理端口，已保留；请使用 --no-web 安装或按手动说明配置，不能自动覆盖。')
    if mapped and all(str(environment.get(k)) == v for k,v in ENVIRONMENT.items()):
        return {'port': port, 'file': None, 'baseline': {str(f): digest(plain_file(f)) for f in context['files']+context['env']}}
    file = context['files'][-1]
    original = plain_file(file)
    patched = patch_compose(original.decode('utf-8-sig'), service, port, add_port=not mapped).encode('utf-8')
    fd, name = tempfile.mkstemp(prefix='.groupguard-check-', suffix=file.suffix, dir=str(file.parent))
    candidate = Path(name)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(patched)
        after = model(context, context['files'][:-1]+[candidate])
        same_except_admin(before, after, service, port)
    finally:
        candidate.unlink(missing_ok=True)
    return {'port': port, 'file': file, 'original': original, 'patched': patched, 'baseline': {str(f): digest(plain_file(f)) for f in context['files']+context['env']}}


def probe_admin(port, attempts=45):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    for attempt in range(attempts):
        try:
            with opener.open('http://127.0.0.1:'+str(port)+'/', timeout=2) as response:
                page = response.read(1024*1024)
                require(response.status == 200 and b'GroupGuard' in page, '该端口响应不是群管页面，已停止验证。')
            try:
                opener.open('http://127.0.0.1:'+str(port)+'/api/config', timeout=2).close()
                raise InstallError('配置接口未要求登录，未通过验证。')
            except urllib.error.HTTPError as error:
                require(error.code == 401, '管理配置接口返回异常，未通过验证。')
            return
        except (OSError, urllib.error.URLError):
            if attempt+1 < attempts:
                time.sleep(1)
    raise InstallError('网页未在等待时间内就绪。请检查 TRSS 加载日志；不要清空 data 或连续重建容器。')


def docker_setup(context, target, plan, restart=True):
    directory = target / 'data/install' / datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ')
    directory.mkdir(mode=0o700)
    record = {'phase': 'prepared', 'service': context['service'], 'project': context['project'], 'port': plan['port'], 'file': str(plan['file']) if plan['file'] else None, 'command': compose_args(context), 'baseline': plan['baseline']}
    state = directory / 'state.json'
    def save():
        private_write(state, (json.dumps(record, ensure_ascii=False, indent=2)+'\n').encode())
    save()
    try:
        for file, checksum in plan['baseline'].items():
            require(digest(plain_file(Path(file))) == checksum, '安装期间 Compose 或环境文件发生变化，已停止。')
        if plan['file']:
            private_write(directory/'compose.before', plan['original'], exclusive=True)
            record['patchedSha256'] = digest(plan['patched'])
            record['mode'] = stat.S_IMODE(plan['file'].stat().st_mode)
            record['phase'] = 'applying-compose'
            save()
            original_stat = plan['file'].stat()
            private_write(plan['file'], plan['patched'])
            os.chmod(plan['file'], stat.S_IMODE(original_stat.st_mode))
            if os.name == 'posix':
                os.chown(plan['file'], original_stat.st_uid, original_stat.st_gid)
        record['phase'] = 'starting-robot' if restart else 'restart-required'
        save()
        if restart:
            print('正在让选中的机器人加载插件，期间会短暂停止回复；不会重启 NapCat 或 Redis。')
            if plan['file']:
                run(compose_args(context)+['up', '-d', '--no-deps', '--no-build', '--pull', 'never', context['service']], timeout=120)
            else:
                run(['docker', 'restart', '--time', '30', context['container']['Id']], timeout=90)
            print('正在检查群管管理页面及未登录访问保护……')
            probe_admin(plan['port'])
            record['phase'] = 'verified'
            save()
        return directory
    except (InstallError, OSError):
        record['phase'] = 'needs-inspection'
        save()
        print('安装未完成；原配置备份和执行阶段保存在：'+str(directory)+'。请按 docs/INSTALL.md 核对或恢复，不自动覆盖回滚。', file=sys.stderr)
        raise


def restart_only(target, container):
    directory = target/'data/install'/datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ')
    directory.mkdir(mode=0o700)
    record = {'phase':'starting-robot','container':container['Id'],'webConfigured':False}
    file = directory/'state.json'
    private_write(file,(json.dumps(record)+'\n').encode())
    try:
        run(['docker','restart','--time','30',container['Id']],timeout=90)
        record['phase']='robot-restarted-qq-verification-pending'
    except InstallError:
        record['phase']='needs-inspection'
        raise
    finally:
        private_write(file,(json.dumps(record)+'\n').encode())
        print('安装记录：'+str(directory))


def print_usage(target, port, docker, masters, restart_required, login):
    print('\n插件目录：'+str(target))
    print('主人配置：'+str(target/'config/local.json')+' → masters（手动填写 QQ 字符串数组）'+('；已配置，不作改动。' if masters else '；当前为空，请按 README 填写。'))
    print('QQ群：由群主或机器人主人发送 #群管开启，再发送 #群管帮助；禁言/踢人需要机器人群管理权限。')
    if restart_required:
        print('尚需重启 TRSS：使用原来的启动/重启方式，然后检查 #群管帮助。插件文件已安装，不代表已经加载。')
    print(('网页：' if docker else '网页默认地址（自定义启动环境以原设置为准）：')+'服务器本机访问 http://127.0.0.1:'+str(port)+'/；初始密码文件 '+str(target/'data/admin-initial-password.txt')+'，登录后必须改密。')
    print('已有管理密码保持不变；安装工具不会读取或显示密码。')
    command = ['ssh', '-N', '-o', 'ExitOnForwardFailure=yes', '-L', '127.0.0.1:36083:127.0.0.1:'+str(port), login or '用户名@服务器公网地址']
    print('远程网页：在你自己电脑的终端执行 '+shlex.join(command))
    print('保持该终端开启，再在电脑浏览器访问 http://127.0.0.1:36083/；36083 被占用时换一个本地端口。')
    if login:
        file = target/'data/install/open-admin.cmd'
        # login is validated before any mutations; no credential or SSH key is embedded.
        text = '@echo off\r\nchcp 65001 >nul\r\necho Keep this window open. Open http://127.0.0.1:36083/ after SSH connects.\r\nssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:36083:127.0.0.1:'+str(port)+' '+login+'\r\npause\r\n'
        private_write(file, text.encode('utf-8'))
        print('可选 Windows 入口：将 '+str(file)+' 下载到自己的电脑后双击。它使用电脑原有 SSH 登录方式，不含密码。')


def main(argv=None):
    require(sys.version_info >= (3, 9), '安装工具需要 Python 3.9 或更高版本；机器人日常运行不依赖 Python。')
    parser = argparse.ArgumentParser(description='群管宿主机安装向导；不安装 TRSS/NapCat，不更新已有群管源码，不修改主人。')
    parser.add_argument('--trss', help='TRSS 在宿主机的目录')
    parser.add_argument('--container', help='多个机器人时指定容器名')
    parser.add_argument('--native', action='store_true', help='明确为普通安装，不查询 Docker')
    parser.add_argument('--env-file', action='append', default=[], help='原 Compose 使用的环境文件，可重复')
    parser.add_argument('--port', type=int, help='宿主机管理端口；默认优先 15083，冲突自动选择到 15103')
    parser.add_argument('--ssh-target', help='生成个人电脑连接入口，例如 ubuntu@server.example.com（不要填密码）')
    parser.add_argument('--no-restart', action='store_true', help='配置完成后不重启，稍后使用原方式重启/重建')
    parser.add_argument('--no-web', action='store_true', help='只安装 QQ 插件，不配置 Docker 网页入口')
    parser.add_argument('--check', action='store_true', help='只识别环境，不写配置、不安装、不重启')
    args = parser.parse_args(argv)
    require(args.port is None or 1024 <= args.port <= 65535, '端口应为 1024～65535。')
    require(not (args.native and args.container), '--native 不能与 --container 一起使用。')
    require(args.ssh_target is None or re.fullmatch(r'[A-Za-z_][A-Za-z0-9_-]*@[A-Za-z0-9][A-Za-z0-9.-]*', args.ssh_target), 'SSH 目标必须是 用户名@主机名/IPv4，不接受密码或其他命令。')
    require(not Path('/.dockerenv').exists() and not Path('/run/.containerenv').exists(), '请在服务器宿主机运行安装工具，不要在机器人容器内部执行。')
    item = choose(discover(args.trss, args.native), args.container)
    root, container = item['root'], item['container']
    print('识别到 '+('Docker' if container else '普通安装')+' TRSS：'+str(root))
    if args.check:
        print('只读检查完成。未安装、未修改、未重启。')
        return 0
    context = compose_context(item, args.env_file) if container and not args.no_web else None
    # Build and validate the complete Compose plan BEFORE writing plugin/config files.
    plan = prepare_compose(context, root/'plugins/GroupGuard-Plugin', args.port) if context else None
    location = item['mount']['Destination'].rstrip('/') if container else None
    if container:
        owner, exec_user = runtime_owner(container, location)
    else:
        require(int(run(['node','-p','process.versions.node.split(".")[0]']).strip()) >= 20, '普通安装需要 Node.js 20+，请先准备 TRSS 运行环境。')
        require(args.port is None, '--port 仅用于 Docker 宿主机端口；普通安装请在原启动环境设置 GROUPGUARD_ADMIN_PORT。')
        parent = root/'plugins' if (root/'plugins').exists() else root
        owner = (parent.stat().st_uid,parent.stat().st_gid) if os.name == 'posix' else None
        exec_user = None
    target, created = ensure_plugin(root)
    if created and owner is not None and os.name == 'posix':
        for directory, directories, files in os.walk(target, followlinks=False):
            os.chown(directory, *owner)
            for name in directories + files:
                file = Path(directory)/name
                require(not file.is_symlink(), '安装源含符号链接，已停止，请检查安装源。')
                os.chown(file, *owner)
    masters = initialize(target, owner)
    lock = target/'data/install/install.lock'
    require(not lock.is_symlink(), '安装锁是符号链接，请先检查。')
    try:
        private_write(lock, str(os.getpid()).encode(), exclusive=True)
    except FileExistsError:
        raise InstallError('另一安装任务或遗留安装锁存在，请检查 data/install/install.lock 对应进程后再处理，不自动删除。') from None
    try:
        if container:
            # Verify writes as the actual container user, not merely as host root.
            plugin_location = location+'/plugins/GroupGuard-Plugin'
            run(['docker','exec','--user',exec_user,container['Id'],'node','-e','const fs=require("node:fs"),p=process.argv[1];fs.accessSync(p+"/config/local.json",fs.constants.R_OK);for(const d of ["/config","/data"])fs.accessSync(p+d,fs.constants.W_OK)',plugin_location])
            current = json.loads(run(['docker','inspect',container['Id']]))[0]
            require(current['Id'] == container['Id'] and current['State']['Running'] and current['State'].get('StartedAt') == container['State'].get('StartedAt'), '安装期间机器人容器发生变化，已停止；请先核对现状。')
            if context:
                recovery = docker_setup(context, target, plan, not args.no_restart)
                print('安装记录：'+str(recovery))
            elif not args.no_restart:
                restart_only(target,container)
        print('已安装完整群管插件。' if created else '使用已有群管目录；源码、配置和管理密码保留。')
        if not args.no_web:
            print_usage(target, plan['port'] if plan else 15083, bool(container), masters, not container or args.no_restart, args.ssh_target)
        else:
            print('未配置网页。请在 TRSS 加载插件后由群主或机器人主人发送 #群管开启；主人仍手动填写 config/local.json 的 masters。')
            if not container or args.no_restart:
                print('尚需按原方式重启 TRSS。')
    finally:
        lock.unlink()
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (InstallError, OSError, ValueError) as error:
        if isinstance(error, InstallError):
            print('安装停止：'+str(error), file=sys.stderr)
        else:
            print('安装停止：文件权限、路径或数据格式异常。原配置不自动清空；请核对 data/install 记录和 docs/INSTALL.md。', file=sys.stderr)
        sys.exit(1)
