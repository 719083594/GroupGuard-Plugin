"""No real Docker daemon, QQ account, filesystem deployment or remote access."""
import contextlib
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('groupguard_installer', Path(__file__).resolve().parents[1]/'scripts/install.py')
installer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(installer)


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='groupguard-installer-test-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        # Helper-level calls below use simulated Docker; don't emit fake progress
        # to the test runner's locale-dependent console.
        self.output = contextlib.redirect_stdout(io.StringIO())
        self.output.__enter__()
        self.addCleanup(self.output.__exit__, None, None, None)

    def target(self):
        target = self.root/'plugins/GroupGuard-Plugin'
        (target/'config').mkdir(parents=True)
        (target/'package.json').write_text('{"name":"groupguard-plugin"}')
        (target/'config/default.json').write_text('{"masters":[],"groups":[]}')
        return target

    def before(self):
        return {'name':'synthetic','services':{'yunzai':{'image':'synthetic', 'environment':{'KEY':'synthetic-secret'},'volumes':[{'type':'bind','source':'/synthetic','target':'/app'}]},'redis':{'image':'synthetic-redis'}}}

    def after(self, before):
        value = copy.deepcopy(before)
        value['services']['yunzai']['environment'].update(installer.ENVIRONMENT)
        value['services']['yunzai']['ports'] = [{'host_ip':'127.0.0.1','target':15083,'published':'15083','protocol':'tcp','mode':'ingress'}]
        return value

    def test_patch_missing_fields_preserves_substitution_and_other_service(self):
        text = '# comment\nservices:\n  yunzai:\n    image: ${IMAGE}\n    volumes:\n      - ./bot:/app\n  redis:\n    image: redis:latest\n'
        result = installer.patch_compose(text,'yunzai',15083)
        self.assertIn('image: ${IMAGE}',result)
        self.assertIn('  redis:\n    image: redis:latest',result)
        self.assertIn('"127.0.0.1:15083:15083"',result)
        self.assertIn('GROUPGUARD_ADMIN_HOST: "0.0.0.0"',result)

    def test_patch_mapping_preserves_keys_and_comments(self):
        text = 'services:\n  yunzai:\n    image: synthetic\n    environment:\n      # keep\n      KEY: ${KEY}\n      GROUPGUARD_ADMIN_HOST: "127.0.0.1"\n    ports:\n      - "127.0.0.1:1234:1234"\n'
        result = installer.patch_compose(text,'yunzai',15083)
        self.assertIn('KEY: ${KEY}',result)
        self.assertIn('# keep',result)
        self.assertEqual(result.count('GROUPGUARD_ADMIN_HOST:'),1)
        self.assertIn('127.0.0.1:1234:1234',result)

    def test_nested_dependency_with_target_name_is_not_a_service(self):
        text = 'services:\n  bridge:\n    image: synthetic\n    depends_on:\n      yunzai:\n        condition: service_started\n  yunzai:\n    image: synthetic\n'
        result = installer.patch_compose(text,'yunzai',15083)
        self.assertIn('    depends_on:\n      yunzai:\n        condition: service_started',result)
        self.assertEqual(result.count('GROUPGUARD_ADMIN_HOST:'),1)

    def test_patch_list_environment_and_crlf(self):
        text = 'services:\r\n  yunzai:\r\n    image: synthetic\r\n    environment:\r\n      - KEY=${KEY}\r\n      - GROUPGUARD_ADMIN_HOST=127.0.0.1\r\n'
        result = installer.patch_compose(text,'yunzai',15100)
        self.assertIn('KEY=${KEY}',result)
        self.assertIn('- "GROUPGUARD_ADMIN_HOST=0.0.0.0"',result)
        self.assertNotIn('\n',result.replace('\r\n',''))

    def test_existing_port_not_duplicated_when_environment_needs_change(self):
        text = 'services:\n  yunzai:\n    image: synthetic\n    ports:\n      - "127.0.0.1:15083:15083"\n'
        result = installer.patch_compose(text,'yunzai',15083,add_port=False)
        self.assertEqual(result.count('127.0.0.1:15083:15083'),1)

    def test_unsupported_yaml_is_refused_without_writes(self):
        for text in ['services: {yunzai: {image: x}}', 'services:\n  yunzai: *shared\n', 'services:\n  yunzai:\n    environment: {KEY: value}\n']:
            with self.subTest(text=text), self.assertRaises(installer.InstallError):
                installer.patch_compose(text,'yunzai',15083)

    def test_semantic_check_accepts_only_admin_changes(self):
        before = self.before()
        after = self.after(before)
        installer.same_except_admin(before,after,'yunzai',15083)
        self.assertNotIn('ports',before['services']['yunzai'])
        for mutate in [lambda x:x['services']['redis'].update(image='changed'), lambda x:x['services']['yunzai']['environment'].update(KEY='changed'), lambda x:x['services']['yunzai']['ports'][0].update(host_ip='0.0.0.0')]:
            wrong = copy.deepcopy(after)
            mutate(wrong)
            with self.assertRaises(installer.InstallError):
                installer.same_except_admin(before,wrong,'yunzai',15083)

    def test_initialize_never_overwrites_config_or_admin_password(self):
        target = self.target()
        self.assertFalse(installer.initialize(target))
        config = target/'config/local.json'
        data = b'{"masters":["123456789"],"extra":"preserve"}'
        config.write_bytes(data)
        auth = target/'data/admin-auth.json'
        auth.write_bytes(b'synthetic-existing-auth')
        self.assertTrue(installer.initialize(target))
        self.assertEqual(config.read_bytes(),data)
        self.assertEqual(auth.read_bytes(),b'synthetic-existing-auth')

    def test_existing_plugin_is_not_updated_or_replaced(self):
        target = self.target()
        (target/'custom.mjs').write_text('keep')
        result, created = installer.ensure_plugin(self.root)
        self.assertFalse(created)
        self.assertEqual(result,target)
        self.assertEqual((target/'custom.mjs').read_text(),'keep')

    def test_new_zip_source_copies_complete_package_without_private_data(self):
        source = self.root/'package'
        (source/'scripts').mkdir(parents=True)
        (source/'package.json').write_text('{"name":"groupguard-plugin"}')
        (source/'scripts/install.py').write_text('# synthetic')
        target, created = installer.ensure_plugin(self.root,source)
        self.assertTrue(created)
        self.assertTrue((target/'scripts/install.py').is_file())
        self.assertFalse((target/'data').exists())

    def test_zip_source_with_instance_data_is_rejected(self):
        source = self.root/'package'
        source.mkdir()
        (source/'package.json').write_text('{"name":"groupguard-plugin"}')
        (source/'data').mkdir()
        with self.assertRaises(installer.InstallError):
            installer.ensure_plugin(self.root,source)
        self.assertFalse((self.root/'plugins/GroupGuard-Plugin').exists())

    def test_multiple_targets_require_selection(self):
        with patch.object(installer.sys.stdin,'isatty',return_value=False), self.assertRaises(installer.InstallError):
            installer.choose([{'root':self.root,'container':None},{'root':self.root/'other','container':None}])

    def test_shared_trss_root_not_silently_modified(self):
        candidates = [{'root':self.root,'container':{'Id':'one','Name':'/one'}},{'root':self.root,'container':{'Id':'two','Name':'/two'}}]
        with self.assertRaises(installer.InstallError):
            installer.choose(candidates,'one')

    def test_unreadable_docker_is_not_misclassified_as_native(self):
        with patch.object(installer.shutil,'which',return_value='docker'), patch.object(installer,'run',side_effect=installer.InstallError('permission denied')):
            with self.assertRaises(installer.InstallError):
                installer.discover(str(self.root))

    def test_explicit_native_does_not_query_docker(self):
        with patch.object(installer,'is_trss',side_effect=lambda p:p==self.root), patch.object(installer,'run') as execute:
            candidates = installer.discover(str(self.root),native=True)
        self.assertEqual(len(candidates),1)
        self.assertIsNone(candidates[0]['container'])
        execute.assert_not_called()

    def test_real_trss_user_mapped_through_user_namespace(self):
        with patch.object(installer,'run',return_value='{"major":24,"uid":1000,"gid":1001}'), patch.object(installer,'plain_file',return_value=b'0 100000 65536\n'):
            owner, user = installer.runtime_owner({'Id':'synthetic','State':{'Pid':123}},'/app')
        self.assertEqual(owner,(101000,101001))
        self.assertEqual(user,'1000:1001')

    def test_native_main_installs_then_preserves_private_config_on_second_run(self):
        target = self.target()
        item = {'root':self.root,'container':None}
        with patch.object(installer,'discover',return_value=[item]), patch.object(installer,'run',return_value='24'), contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(installer.main(['--no-web']),0)
        self.assertIn('尚需按原方式重启',output.getvalue())
        file = target/'config/local.json'
        file.write_bytes(b'{"masters":["123456789"],"groups":[]}')
        original = file.read_bytes()
        with patch.object(installer,'discover',return_value=[item]), patch.object(installer,'run',return_value='24'), contextlib.redirect_stdout(io.StringIO()):
            installer.main(['--no-web'])
        self.assertEqual(file.read_bytes(),original)
        self.assertFalse((target/'data/install/install.lock').exists())

    def test_check_mode_creates_nothing(self):
        with patch.object(installer,'discover',return_value=[{'root':self.root,'container':None}]), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(installer.main(['--check']),0)
        self.assertEqual(list(self.root.iterdir()),[])

    def test_port_reuse_and_public_mapping_refusal(self):
        before = self.after(self.before())
        self.assertEqual(installer.select_port(before,'yunzai'),(15083,True))
        before['services']['yunzai']['ports'][0]['host_ip']='0.0.0.0'
        with self.assertRaises(installer.InstallError):
            installer.select_port(before,'yunzai')

    def test_existing_compose_drift_stops_before_writes(self):
        file = self.root/'compose.yaml'
        file.write_text('synthetic')
        context = {'service':'yunzai','project':'synthetic','directory':self.root,'files':[file],'env':[],'container':{'Config':{'Labels':{'com.docker.compose.config-hash':'old'}}}}
        with patch.object(installer,'model',return_value=self.before()), patch.object(installer,'run',return_value='yunzai changed'), self.assertRaises(installer.InstallError):
            installer.prepare_compose(context,self.root)
        self.assertEqual(file.read_text(),'synthetic')

    def test_validation_refusal_deletes_candidate_preserves_original(self):
        file = self.root/'compose.yaml'
        original = b'services:\n  yunzai:\n    image: synthetic\n'
        file.write_bytes(original)
        context = {'service':'yunzai','project':'synthetic','directory':self.root,'files':[file],'env':[],'container':{'Config':{'Labels':{'com.docker.compose.config-hash':'same'}}}}
        with patch.object(installer,'model',side_effect=[self.before(),self.before()]), patch.object(installer,'run',return_value='yunzai same'), self.assertRaises(installer.InstallError):
            installer.prepare_compose(context,self.root,15083)
        self.assertEqual(file.read_bytes(),original)
        self.assertEqual(list(self.root.glob('.groupguard-check-*')),[])

    def test_timeout_is_unknown_and_never_contains_captured_secrets(self):
        import subprocess
        with patch.object(installer.subprocess,'run',side_effect=subprocess.TimeoutExpired(['docker'],1,output='synthetic-secret')):
            with self.assertRaises(installer.InstallError) as result:
                installer.run(['docker'])
        self.assertIn('结果可能已经生效',str(result.exception))
        self.assertNotIn('synthetic-secret',str(result.exception))

    def test_apply_backs_up_preserves_mode_and_restarts_only_target(self):
        target = self.target()
        installer.initialize(target)
        file = self.root/'compose.yaml'
        file.write_bytes(b'original')
        plan = {'file':file,'original':b'original','patched':b'patched','port':15083,'baseline':{str(file):installer.digest(b'original')}}
        context = {'service':'yunzai','project':'synthetic','directory':self.root,'files':[file],'env':[],'container':{'Id':'synthetic-robot'}}
        with patch.object(installer,'run',return_value='') as execute, patch.object(installer,'probe_admin'):
            recovery = installer.docker_setup(context,target,plan)
        self.assertEqual((recovery/'compose.before').read_bytes(),b'original')
        self.assertEqual(file.read_bytes(),b'patched')
        self.assertEqual(json.loads((recovery/'state.json').read_text())['phase'],'verified')
        command = execute.call_args.args[0]
        self.assertEqual(command[-7:],['up','-d','--no-deps','--no-build','--pull','never','yunzai'])
        self.assertIn('--no-deps',command)
        self.assertIn('--no-build',command)
        self.assertEqual(command[-1],'yunzai')
        self.assertNotIn('down',command)

    def test_uncertain_apply_retains_backup_without_automatic_retry(self):
        target = self.target()
        installer.initialize(target)
        file = self.root/'compose.yaml'
        file.write_bytes(b'original')
        plan = {'file':file,'original':b'original','patched':b'patched','port':15083,'baseline':{str(file):installer.digest(b'original')}}
        context = {'service':'yunzai','project':'synthetic','directory':self.root,'files':[file],'env':[],'container':{'Id':'synthetic-robot'}}
        with patch.object(installer,'run',side_effect=installer.InstallError('unknown')) as execute, contextlib.redirect_stderr(io.StringIO()), self.assertRaises(installer.InstallError):
            installer.docker_setup(context,target,plan)
        self.assertEqual(execute.call_count,1)
        record = next((target/'data/install').glob('*/state.json'))
        self.assertEqual(json.loads(record.read_text())['phase'],'needs-inspection')
        self.assertEqual((record.parent/'compose.before').read_bytes(),b'original')
        self.assertEqual(file.read_bytes(),b'patched')

    def test_repeated_setup_with_no_compose_change_restarts_existing_container(self):
        target = self.target()
        installer.initialize(target)
        context = {'service':'yunzai','project':'synthetic','directory':self.root,'files':[],'env':[],'container':{'Id':'synthetic-robot'}}
        with patch.object(installer,'run',return_value='') as execute, patch.object(installer,'probe_admin'):
            installer.docker_setup(context,target,{'file':None,'port':15083,'baseline':{}})
        self.assertEqual(execute.call_args.args[0],['docker','restart','--time','30','synthetic-robot'])

    def test_qq_only_restart_timeout_is_recorded_without_retry(self):
        target = self.target()
        installer.initialize(target)
        with patch.object(installer,'run',side_effect=installer.InstallError('unknown')) as execute, contextlib.redirect_stdout(io.StringIO()), self.assertRaises(installer.InstallError):
            installer.restart_only(target,{'Id':'synthetic-robot'})
        self.assertEqual(execute.call_count,1)
        record = next((target/'data/install').glob('*/state.json'))
        self.assertEqual(json.loads(record.read_text())['phase'],'needs-inspection')

    def test_shell_entry_is_fixed_official_repo_and_forwards_arguments(self):
        entry = (Path(__file__).resolve().parents[1]/'scripts/install.sh').read_text(encoding='utf-8')
        self.assertIn(installer.REPOSITORY,entry)
        self.assertIn('"$@"',entry)
        self.assertNotIn('sudo',entry)
        self.assertNotIn('docker.sock',entry)

    def test_cli_console_supports_chinese_when_original_encoding_is_cp1252(self):
        raw = io.BytesIO()
        stream = io.TextIOWrapper(raw,encoding='cp1252')
        with patch.object(installer.sys,'stdout',stream):
            installer.configure_console()
            print('群管安装')
            stream.flush()
        self.assertEqual(raw.getvalue().decode('utf-8').strip(),'群管安装')

    def test_cli_rejects_shell_injection_before_discovery(self):
        with patch.object(installer,'discover') as discovery, self.assertRaises(installer.InstallError):
            installer.main(['--ssh-target','user@host & malicious'])
        discovery.assert_not_called()


if __name__ == '__main__':
    unittest.main()
