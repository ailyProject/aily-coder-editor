import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createHostAilyLibraryPage,
  normalizeLibraryLanguage,
} from './ailyComponentLibraryModel.js'

const catalog = [
  {
    packageName: '@aily-project/lib-servo',
    name: '舵机驱动库',
    description: '控制 Servo 舵机',
    version: '1.2.0',
    author: 'Aily',
    url: 'https://example.com/servo',
    keywords: ['motor'],
    architectures: ['esp32'],
    tested: true,
    installed: false,
    installedVersion: '',
  },
  {
    packageName: '@aily-project/lib-display',
    name: '显示屏库',
    description: 'OLED display',
    version: '2.0.0',
    author: '',
    url: '',
    keywords: ['screen'],
    architectures: [],
    tested: false,
    installed: false,
    installedVersion: '',
  },
] as const

test('uses the host catalog order and project dependencies for installed state', () => {
  const page = createHostAilyLibraryPage(
    catalog,
    { '@aily-project/lib-servo': '^1.2.0' },
    '',
    0,
    50,
  )
  assert.equal(page.total, 2)
  assert.deepEqual(page.libraries.map(item => item.name), ['舵机驱动库', '显示屏库'])
  assert.equal(page.libraries[0]?.installed, true)
  assert.equal(page.libraries[0]?.installedVersion, '1.2.0')
  assert.equal(page.libraries[1]?.installed, false)
})

test('searches localized host fields and never consults an appdata index', () => {
  assert.deepEqual(
    createHostAilyLibraryPage(catalog, {}, 'Servo motor', 0, 50).libraries.map(item => item.packageName),
    ['@aily-project/lib-servo'],
  )
  assert.deepEqual(
    createHostAilyLibraryPage(catalog, {}, 'OLED', 0, 50).libraries.map(item => item.packageName),
    ['@aily-project/lib-display'],
  )
})

test('normalizes the language codes used by the host and VS Code packs', () => {
  assert.equal(normalizeLibraryLanguage('zh_cn'), 'zh_cn')
  assert.equal(normalizeLibraryLanguage('zh-Hant'), 'zh_hk')
  assert.equal(normalizeLibraryLanguage('pt-BR'), 'pt')
  assert.equal(normalizeLibraryLanguage('ar'), 'ar')
  assert.equal(normalizeLibraryLanguage('unknown'), 'en')
})
