import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8')
    .replaceAll('import.meta.url', JSON.stringify('http://localhost/scripts/extensions/third-party/renamed-folder/index.js'));
const stylesheet = fs.readFileSync(new URL('../style.css', import.meta.url), 'utf8');
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
assert.equal(vm.runInContext('settings.promptSchemaVersion', context), 2);
assert.equal(vm.runInContext("getProcessLabel()", context), '찰떡 교정하기');
assert.match(vm.runInContext("getSourceHint('light')", context), /맞춤법/);
assert.match(vm.runInContext("getSourceHint('polish')", context), /문체/);

const lightPrompt = vm.runInContext("buildPrompt('원문', 'light')", context);
assert.match(lightPrompt, /\[기본 지시사항 \/ Base instructions\]/);
assert.doesNotMatch(lightPrompt, /\[찰떡 지시사항 \/ Style instructions\]/);
assert.match(lightPrompt, /\[안돼 지시사항 \/ Prohibitions\]/);
assert.match(lightPrompt, /\[원문 \/ Source\]\n원문$/);

const polishPrompt = vm.runInContext("buildPrompt('원문', 'polish')", context);
assert.match(polishPrompt, /\[찰떡 지시사항 \/ Style instructions\]/);

const englishPrompt = vm.runInContext("buildPrompt(\"He don't knows why.\", 'polish')", context);
assert.match(englishPrompt, /영어는 영어로 유지/);
assert.match(englishPrompt, /instructions are written|추가 지시사항은 한국어와 영어/i);
assert.match(englishPrompt, /spelling, grammar, punctuation, articles, prepositions/);
assert.match(englishPrompt, /영미권 소설 문체/);
assert.match(englishPrompt, /\[원문 \/ Source\]\nHe don't knows why\.$/);

const preservedLabel = vm.runInContext("cleanOutput('결과: 실패였다.')", context);
assert.equal(preservedLabel, '결과: 실패였다.');

const strippedHeader = vm.runInContext("cleanOutput('결과:\\n다듬은 문장')", context);
assert.equal(strippedHeader, '다듬은 문장');

const strippedFence = vm.runInContext("cleanOutput('```text\\n다듬은 문장\\n```')", context);
assert.equal(strippedFence, '다듬은 문장');

const preservedEnglishLabel = vm.runInContext("cleanOutput('Result: Failure.')", context);
assert.equal(preservedEnglishLabel, 'Result: Failure.');

const strippedEnglishHeader = vm.runInContext("cleanOutput('Result:\\nRevised sentence.')", context);
assert.equal(strippedEnglishHeader, 'Revised sentence.');

const strippedEnglishPreamble = vm.runInContext("cleanOutput(\"Here's the revised text:\\nRevised sentence.\")", context);
assert.equal(strippedEnglishPreamble, 'Revised sentence.');

vm.runInContext("settings.forbiddenWords = ['문득', '어쩐지']", context);
const forbiddenPrompt = vm.runInContext("buildPrompt('원문', 'polish')", context);
assert.match(forbiddenPrompt, /금지단어 \/ Banned terms: 문득, 어쩐지/);

const migratedBasePrompt = vm.runInContext(`(() => {
    const saved = {
        promptSchemaVersion: 1,
        basePrompt: LEGACY_DEFAULT_PROMPTS.basePrompt,
        polishPrompt: LEGACY_DEFAULT_PROMPTS.polishPrompt,
        forbiddenPrompt: LEGACY_DEFAULT_PROMPTS.forbiddenPrompt,
    };
    migratePromptSettings(saved);
    return saved.basePrompt;
})()`, context);
assert.equal(migratedBasePrompt, vm.runInContext('DEFAULT_SETTINGS.basePrompt', context));

const preservedCustomPrompt = vm.runInContext(`(() => {
    const saved = {
        promptSchemaVersion: 1,
        basePrompt: 'Keep contractions. 욕설은 유지하세요.',
    };
    migratePromptSettings(saved);
    return saved.basePrompt;
})()`, context);
assert.equal(preservedCustomPrompt, 'Keep contractions. 욕설은 유지하세요.');

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

vm.runInContext(`
    globalThis.__gctWandLabel = { textContent: '' };
    globalThis.__gctWandState = { off: false, checked: '' };
    globalThis.__gctFields['#gct-wand-toggle'] = {
        querySelector: () => globalThis.__gctWandLabel,
        classList: {
            toggle: (_name, active) => globalThis.__gctWandState.off = active,
        },
        setAttribute: (_name, value) => globalThis.__gctWandState.checked = value,
        title: '',
    };
    settings.widgetVisible = true;
    renderWandToggle();
`, context);
assert.equal(vm.runInContext('__gctWandLabel.textContent', context), '개떡찰떡 탭: 켜짐');
assert.equal(vm.runInContext('__gctWandState.off', context), false);
assert.equal(vm.runInContext('__gctWandState.checked', context), 'true');

vm.runInContext(`
    settings.widgetVisible = false;
    renderWandToggle();
`, context);
assert.equal(vm.runInContext('__gctWandLabel.textContent', context), '개떡찰떡 탭: 꺼짐');
assert.equal(vm.runInContext('__gctWandState.off', context), true);
assert.equal(vm.runInContext('__gctWandState.checked', context), 'false');

assert.match(source, /data-gct-quick-mode="light"/);
assert.match(source, /data-gct-quick-mode="polish"/);
assert.doesNotMatch(source, /syncEditorFromInput/);
assert.match(source, /document\.body\.append\(root\)/);
assert.doesNotMatch(source, /sendForm\.append\(root\)/);
assert.match(source, /id="gct-launcher-drag"/);
assert.match(source, /id="gct-widget-close"/);
assert.match(source, /document\.querySelector\('#extensionsMenu'\)/);
assert.match(source, /className = 'extension_container'/);
assert.match(source, /menu\.prepend\(container\)/);
assert.match(source, /#extensionsMenuButton/);
assert.match(source, /button\.addEventListener\('click', \(\) => createWandToggle\(\)\)/);
assert.match(source, /toggle\.addEventListener\('click', \(\) => setWidgetVisible\(!settings\.widgetVisible\)\)/);
assert.match(stylesheet, /#gct-root \.gct-quick-menu button:last-child small\s*\{[^}]*color:\s*#fff\s*!important/s);

console.log('개떡찰떡 smoke tests passed');
