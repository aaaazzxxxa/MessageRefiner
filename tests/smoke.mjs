import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8')
    .replaceAll('import.meta.url', JSON.stringify('http://localhost/scripts/extensions/third-party/renamed-folder/index.js'));
const context = vm.createContext({
    console,
    URL,
    Event,
    structuredClone,
    setTimeout,
    clearTimeout,
    toastr: { info: () => {}, success: () => {}, error: () => {} },
    SillyTavern: {
        getContext: () => ({
            extensionSettings: {},
            saveSettingsDebounced: () => {},
            eventSource: { on: () => {} },
            event_types: { APP_READY: 'app_ready' },
        }),
    },
});

vm.runInContext(source, context);
vm.runInContext('loadSettings()', context);

assert.equal(
    vm.runInContext('EXTENSION_FOLDER', context),
    'third-party/renamed-folder',
);
assert.equal(
    vm.runInContext('ICON_PATH', context),
    'http://localhost/scripts/extensions/third-party/renamed-folder/assets/gaetteok-chaltteok.png',
);
assert.equal(
    vm.runInContext('CONNECTION_SERVICE_PATH', context),
    'http://localhost/scripts/extensions/shared.js',
);
assert.equal(vm.runInContext('settings.widgetVisible', context), true);
assert.equal(vm.runInContext('settings.connectionProfileId', context), '');
assert.equal(vm.runInContext("getProcessLabel()", context), '찰떡 교정하기');
assert.match(vm.runInContext("getSourceHint('light')", context), /맞춤법/);
assert.match(vm.runInContext("getSourceHint('polish')", context), /문체/);

const lightPrompt = vm.runInContext("buildPrompt('원문', 'light')", context);
assert.match(lightPrompt, /\[기본 지시사항\]/);
assert.doesNotMatch(lightPrompt, /\[찰떡 지시사항\]/);
assert.match(lightPrompt, /\[안돼 지시사항\]/);
assert.match(lightPrompt, /\[원문\]\n원문$/);

const polishPrompt = vm.runInContext("buildPrompt('원문', 'polish')", context);
assert.match(polishPrompt, /\[찰떡 지시사항\]/);

const preservedLabel = vm.runInContext("cleanOutput('결과: 실패였다.')", context);
assert.equal(preservedLabel, '결과: 실패였다.');

const strippedHeader = vm.runInContext("cleanOutput('결과:\\n다듬은 문장')", context);
assert.equal(strippedHeader, '다듬은 문장');

const strippedFence = vm.runInContext("cleanOutput('```text\\n다듬은 문장\\n```')", context);
assert.equal(strippedFence, '다듬은 문장');

vm.runInContext("settings.forbiddenWords = ['문득', '어쩐지']", context);
const forbiddenPrompt = vm.runInContext("buildPrompt('원문', 'polish')", context);
assert.match(forbiddenPrompt, /금지단어: 문득, 어쩐지/);

vm.runInContext(`
    globalThis.__gctFields = {
        '#gct-source': { value: '', placeholder: '' },
        '#gct-result': { value: '', placeholder: '' },
    };
    globalThis.document = {
        querySelector: (selector) => globalThis.__gctFields[selector] ?? null,
        querySelectorAll: () => [],
    };
    setEditorSession('교정 전 원문', '교정 후 결과');
`, context);
assert.equal(vm.runInContext("__gctFields['#gct-source'].value", context), '교정 전 원문');
assert.equal(vm.runInContext("__gctFields['#gct-result'].value", context), '교정 후 결과');

vm.runInContext('clearEditor()', context);
assert.equal(vm.runInContext("__gctFields['#gct-source'].value", context), '');
assert.equal(vm.runInContext("__gctFields['#gct-result'].value", context), '');
assert.match(vm.runInContext("__gctFields['#gct-source'].placeholder", context), /문체/);

await vm.runInContext(`(async () => {
    globalThis.__gctFields['#send_textarea'] = {
        value: '빠른 교정 전 원문',
        dispatchEvent: () => {},
        focus: () => {},
    };
    refineText = async () => '빠른 교정 결과';
    await quickApply('light');
    clearTimeout(undoTimer);
})()`, context);
assert.equal(vm.runInContext("__gctFields['#send_textarea'].value", context), '빠른 교정 결과');
assert.equal(vm.runInContext("__gctFields['#gct-source'].value", context), '빠른 교정 전 원문');
assert.equal(vm.runInContext("__gctFields['#gct-result'].value", context), '빠른 교정 결과');

vm.runInContext(`
    const testClasses = new Set();
    globalThis.__gctRootStyle = { removeProperty(name) { delete this[name]; } };
    globalThis.__gctFields['#gct-root'] = {
        offsetWidth: 360,
        style: globalThis.__gctRootStyle,
        classList: {
            toggle: (name, active) => active ? testClasses.add(name) : testClasses.delete(name),
            remove: (name) => testClasses.delete(name),
        },
    };
    globalThis.__gctFields['#gct-launcher'] = { offsetHeight: 38 };
    globalThis.__gctFields['#send_form'] = {
        getBoundingClientRect: () => ({ left: 15, top: 700, width: 360 }),
    };
    globalThis.window = { innerWidth: 390, innerHeight: 844 };
    settings.widgetPosition = null;
    applyWidgetPosition();
`, context);
assert.equal(vm.runInContext('__gctRootStyle.width', context), '360px');
assert.equal(vm.runInContext('__gctRootStyle.left', context), '15px');
assert.equal(vm.runInContext('__gctRootStyle.top', context), '658px');

assert.match(source, /data-gct-quick-mode="light"/);
assert.match(source, /data-gct-quick-mode="polish"/);
assert.doesNotMatch(source, /syncEditorFromInput/);
assert.match(source, /document\.body\.append\(root\)/);
assert.doesNotMatch(source, /sendForm\.append\(root\)/);
assert.match(source, /id="gct-launcher-drag"/);
assert.match(source, /id="gct-widget-close"/);

console.log('개떡찰떡 smoke tests passed');
