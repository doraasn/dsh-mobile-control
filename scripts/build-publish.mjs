/**
 * 生成发布副本：把开发身份 `@local/dsh-mobile-control` 统一改成对外包名。
 *
 * 三处必须同时改，否则 DSH 会报 duplicate factory registration：
 *   1. package.json      name
 *   2. cordis.patch.yml  name
 *   3. lib/client.js     window.__ModuleLoader__.load({ id })
 *
 * 用法: node scripts/build-publish.mjs [--out publish]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PUBLISH_NAME = 'dsh-mobile-control'
const outIndex = process.argv.indexOf('--out')
const OUT = path.resolve(ROOT, outIndex > 0 ? process.argv[outIndex + 1] : 'publish')

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const write = (rel, text) => {
  const target = path.join(OUT, rel)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, text)
}
const copy = (rel) => {
  const target = path.join(OUT, rel)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.copyFileSync(path.join(ROOT, rel), target)
}

fs.rmSync(OUT, { recursive: true, force: true })

const pkg = JSON.parse(read('package.json'))
const LOCAL_NAME = pkg.name
pkg.name = PUBLISH_NAME
pkg.repository = { type: 'git', url: 'git+https://github.com/doraasn/dsh-mobile-control.git' }
pkg.homepage = 'https://github.com/doraasn/dsh-mobile-control#readme'
pkg.bugs = { url: 'https://github.com/doraasn/dsh-mobile-control/issues' }
pkg.publishConfig = { access: 'public' }
if (!pkg.files.includes('test/')) pkg.files.push('test/')
write('package.json', JSON.stringify(pkg, null, 2) + '\n')

for (const rel of ['cordis.patch.yml', 'icon.svg', 'README.md', 'LICENSE', 'locale']) {
  if (fs.existsSync(path.join(ROOT, rel))) {
    if (fs.statSync(path.join(ROOT, rel)).isDirectory()) {
      for (const entry of fs.readdirSync(path.join(ROOT, rel))) copy(path.join(rel, entry))
    } else {
      copy(rel)
    }
  }
}

for (const entry of fs.readdirSync(path.join(ROOT, 'lib'))) copy(path.join('lib', entry))
if (fs.existsSync(path.join(ROOT, 'test'))) {
  for (const entry of fs.readdirSync(path.join(ROOT, 'test'))) copy(path.join('test', entry))
}

// 两处身份替换
write('cordis.patch.yml', read('cordis.patch.yml').split(LOCAL_NAME).join(PUBLISH_NAME))
write('lib/client.js', read('lib/client.js').split(`id: "${LOCAL_NAME}"`).join(`id: "${PUBLISH_NAME}"`).split(`id: '${LOCAL_NAME}'`).join(`id: '${PUBLISH_NAME}'`))

// 自检：三处一致
const published = JSON.parse(fs.readFileSync(path.join(OUT, 'package.json'), 'utf8'))
const patch = fs.readFileSync(path.join(OUT, 'cordis.patch.yml'), 'utf8')
const client = fs.readFileSync(path.join(OUT, 'lib', 'client.js'), 'utf8')
const problems = []
if (published.name !== PUBLISH_NAME) problems.push(`package.json name=${published.name}`)
if (!patch.includes(PUBLISH_NAME)) problems.push('cordis.patch.yml 里没有发布名')
if (!client.includes(`id: "${PUBLISH_NAME}"`) && !client.includes(`id: '${PUBLISH_NAME}'`)) problems.push('client.js 的 id 没改')
if (problems.length) {
  console.error('发布副本自检失败：\n  ' + problems.join('\n  '))
  process.exit(1)
}
console.log(`输出目录: ${OUT}`)
console.log(`  package.json      ${published.name}@${published.version}`)
console.log(`  cordis.patch.yml  ${PUBLISH_NAME}`)
console.log(`  lib/client.js     ${PUBLISH_NAME}`)
console.log(`✓ 三处名字一致: ${PUBLISH_NAME}`)
