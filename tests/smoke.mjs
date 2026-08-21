import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const context = vm.createContext({
    console,
    structuredClone,
    setTimeout,
    clearTimeout,
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

console.log('개떡찰떡 smoke tests passed');
