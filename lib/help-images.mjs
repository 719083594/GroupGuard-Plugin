/** Read fixed help through AI-Plugin without starting AI, a browser or a renderer.
 * Missing images or an absent optional sibling plugin retain the text fallback. */
export function createHelpImages({root, loadService = () => import('../../AI-Plugin/src/rendering/index.mjs')} = {}) {
  if (typeof root !== 'string' || !root || typeof loadService !== 'function') throw new TypeError('INVALID_HELP_READER')
  let pending
  return async function helpImages({isMaster = false, privateChat = false} = {}) {
    if (!pending) pending = Promise.resolve().then(loadService).then(service => {
      if (typeof service?.createStaticHelpReader !== 'function') throw new Error('HELP_READER_UNAVAILABLE')
      const reader = service.createStaticHelpReader({root})
      if (typeof reader !== 'function') throw new Error('HELP_READER_UNAVAILABLE')
      return reader
    }).catch(() => { pending = undefined; return null })
    const read = await pending
    if (!read) return null
    const topics = ['groupguard-public']
    if (isMaster === true && privateChat === true) topics.push('groupguard-master')
    const images = []
    for (const topic of topics) {
      const pages = read({topic, private: false})
      if (!Array.isArray(pages) || !pages.length || pages.some(page => !Buffer.isBuffer(page))) return null
      images.push(...pages.map(page => Buffer.from(page)))
    }
    return images
  }
}
