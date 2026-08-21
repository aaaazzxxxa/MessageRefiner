const MODULE_NAME = 'gaetteok_chaltteok';
const EXTENSION_BASE_URL = new URL('.', import.meta.url);
const EXTENSION_FOLDER = decodeURIComponent(EXTENSION_BASE_URL.pathname)
    .replace(/^.*\/scripts\/extensions\//, '')
    .replace(/\/$/, '');
const ICON_PATH = new URL('assets/gaetteok-chaltteok.png', EXTENSION_BASE_URL).href;

const DEFAULT_SETTINGS = Object.freeze({
    mode: 'polish',
    basePrompt: [
        '당신은 사용자가 이미 작성한 한국어 메시지를 보내기 전에 다듬는 후처리기입니다.',
        '대필하거나 내용을 확장하지 말고 원문의 의미, 시점, 인물, 정보, 대사, 욕설, 유머, 감정 강도를 유지하세요.',
        '맞춤법, 띄어쓰기, 조사, 어순, 문장 호응, 불필요한 반복과 어색한 연결을 자연스럽게 고치세요.',
        '설명, 평가, 머리말, 따옴표, 마크다운 코드 블록 없이 수정된 본문만 출력하세요.',
    ].join('\n'),
    polishPrompt: [
        '단순 교정을 넘어 번역투를 줄이고 자연스러운 한국 웹소설 문체로 다듬으세요.',
        '어색한 표현을 더 적절한 어휘로 바꾸고 문장 호흡과 리듬을 정돈하세요.',
        '필요하면 문장을 나누거나 합치되 원문의 욕설, 유머, 날것 같은 감정선은 유지하세요.',
    ].join('\n'),
    forbiddenPrompt: [
        '입력에 없는 행동, 감정, 사건, 설정, 소품, 배경, 원인, 결과, 상대 캐릭터의 반응, 생각, 대사를 추가하지 마세요.',
        '원문의 의미, 시점, 사실관계, 관계, 서술 주체를 바꾸지 마세요.',
        '묘사를 과장하거나 원문에 있는 정보를 삭제하지 마세요.',
        '금지단어가 지정되면 결과에 사용하지 말고 문맥에 맞는 다른 표현으로 대체하세요.',
    ].join('\n'),
    forbiddenWords: [],
});

let settings;
let isBusy = false;
let lastUndo = null;
let undoTimer = null;

function getContext() {
    return SillyTavern.getContext();
}

function cloneDefaults() {
    return structuredClone(DEFAULT_SETTINGS);
}

function loadSettings() {
    const { extensionSettings } = getContext();
    const saved = extensionSettings[MODULE_NAME];

    if (!saved || typeof saved !== 'object') {
        extensionSettings[MODULE_NAME] = cloneDefaults();
    } else {
        for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
            if (!Object.hasOwn(saved, key)) {
                saved[key] = structuredClone(value);
            }
        }
    }

    settings = extensionSettings[MODULE_NAME];
    settings.mode = settings.mode === 'light' ? 'light' : 'polish';
    settings.forbiddenWords = normalizeWords(settings.forbiddenWords);
    return settings;
}

function saveSettings() {
    getContext().saveSettingsDebounced();
}

function normalizeWords(words) {
    if (!Array.isArray(words)) return [];
    return [...new Set(words.map((word) => String(word).trim()).filter(Boolean))];
}

function getInput() {
    return document.querySelector('#send_textarea');
}

function setInputValue(value) {
    const input = getInput();
    if (!input) return false;
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.focus();
    return true;
}

function buildPrompt(source, mode = settings.mode, usePlaceholder = false) {
    const original = usePlaceholder ? '{{원문}}' : source;
    const sections = [
        `[기본 지시사항]\n${settings.basePrompt.trim()}`,
    ];

    if (mode === 'polish') {
        sections.push(`[찰떡 지시사항]\n${settings.polishPrompt.trim()}`);
    }

    sections.push(`[안돼 지시사항]\n${settings.forbiddenPrompt.trim()}`);

    if (settings.forbiddenWords.length > 0) {
        sections.push(`금지단어: ${settings.forbiddenWords.join(', ')}`);
    }

    sections.push(`[원문]\n${original}`);
    return sections.filter((section) => section.trim()).join('\n\n');
}

async function getGenerateRaw() {
    const contextGenerator = getContext().generateRaw;
    if (typeof contextGenerator === 'function') return contextGenerator;

    const module = await import('/script.js');
    if (typeof module.generateRaw !== 'function') {
        throw new Error('현재 SillyTavern에서 generateRaw API를 찾을 수 없습니다.');
    }
    return module.generateRaw;
}

function cleanOutput(raw) {
    let output = String(raw ?? '').trim();
    const fenced = output.match(/^```(?:text|plaintext|markdown)?\s*\n([\s\S]*?)\n```$/i);
    if (fenced) output = fenced[1].trim();
    output = output.replace(/^(?:수정된 본문|결과|출력)\s*:\s*\n/i, '').trim();
    return output;
}

async function refineText(source, mode) {
    const generateRaw = await getGenerateRaw();
    const raw = await generateRaw({ prompt: buildPrompt(source, mode) });
    const result = cleanOutput(raw);
    if (!result) throw new Error('모델이 빈 결과를 반환했습니다.');
    return result;
}

function setBusy(busy) {
    isBusy = busy;
    document.querySelectorAll('[data-gct-run]').forEach((button) => {
        button.disabled = busy;
    });
    document.querySelectorAll('.gct-rice-button, .gct-panel-icon').forEach((button) => {
        button.classList.toggle('gct-busy', busy);
        button.setAttribute('aria-busy', String(busy));
    });
    const processButton = document.querySelector('#gct-process');
    if (processButton) processButton.textContent = busy ? '다듬는 중...' : getProcessLabel();
}

function getProcessLabel() {
    return settings.mode === 'light' ? '살짝 교정하기' : '찰떡으로 다듬기';
}

function rememberUndo(original, revised) {
    lastUndo = { original, revised };
    const undoBar = document.querySelector('#gct-undo-bar');
    if (undoBar) undoBar.hidden = false;
    clearTimeout(undoTimer);
    undoTimer = setTimeout(() => {
        if (undoBar) undoBar.hidden = true;
    }, 10000);
}

function undoLast() {
    if (!lastUndo) {
        toastr.info('되돌릴 내용이 없습니다.');
        return;
    }
    setInputValue(lastUndo.original);
    const source = document.querySelector('#gct-source');
    const result = document.querySelector('#gct-result');
    if (source) source.value = lastUndo.original;
    if (result) result.value = lastUndo.revised;
    document.querySelector('#gct-undo-bar')?.setAttribute('hidden', '');
    lastUndo = null;
    toastr.success('원래 입력으로 되돌렸습니다.');
}

async function quickApply() {
    if (isBusy) return;
    const input = getInput();
    const source = input?.value.trim();
    if (!source) {
        toastr.info('먼저 다듬을 메시지를 입력하세요.');
        input?.focus();
        return;
    }

    setBusy(true);
    try {
        const result = await refineText(source, settings.mode);
        rememberUndo(input.value, result);
        setInputValue(result);
        syncEditorFromInput(false);
        toastr.success('입력창에 찰떡같이 적용했습니다.');
    } catch (error) {
        console.error('[개떡찰떡] 빠른 적용 실패:', error);
        toastr.error(error?.message || '메시지를 다듬지 못했습니다.');
    } finally {
        setBusy(false);
    }
}

async function processInPanel() {
    if (isBusy) return;
    const sourceField = document.querySelector('#gct-source');
    const resultField = document.querySelector('#gct-result');
    const source = sourceField?.value.trim();

    if (!source) {
        toastr.info('원문을 입력하세요.');
        sourceField?.focus();
        return;
    }

    setBusy(true);
    try {
        resultField.value = await refineText(source, settings.mode);
        resultField.focus();
    } catch (error) {
        console.error('[개떡찰떡] 편집 탭 처리 실패:', error);
        toastr.error(error?.message || '메시지를 다듬지 못했습니다.');
    } finally {
        setBusy(false);
    }
}

function applyPanelResult() {
    const input = getInput();
    const result = document.querySelector('#gct-result')?.value;
    if (!input || !result?.trim()) {
        toastr.info('적용할 결과가 없습니다.');
        return;
    }
    rememberUndo(input.value, result);
    setInputValue(result);
    closePanel();
    toastr.success('입력창에 적용했습니다.');
}

function syncEditorFromInput(clearResult = true) {
    const source = document.querySelector('#gct-source');
    const result = document.querySelector('#gct-result');
    if (source && getInput()) source.value = getInput().value;
    if (result && clearResult) result.value = '';
}

function openPanel() {
    const panel = document.querySelector('#gct-panel');
    if (!panel) return;
    syncEditorFromInput(true);
    panel.hidden = false;
    document.querySelector('#gct-launcher')?.classList.add('gct-open');
    document.querySelector('#gct-source')?.focus();
}

function closePanel() {
    const panel = document.querySelector('#gct-panel');
    if (panel) panel.hidden = true;
    document.querySelector('#gct-launcher')?.classList.remove('gct-open');
}

function togglePanel() {
    const panel = document.querySelector('#gct-panel');
    if (!panel || panel.hidden) openPanel();
    else closePanel();
}

function setMode(mode) {
    settings.mode = mode === 'light' ? 'light' : 'polish';
    saveSettings();
    syncModeButtons();
    updatePromptPreview();
    const processButton = document.querySelector('#gct-process');
    if (processButton && !isBusy) processButton.textContent = getProcessLabel();
}

function syncModeButtons() {
    document.querySelectorAll('[data-gct-mode]').forEach((button) => {
        const active = button.dataset.gctMode === settings.mode;
        button.classList.toggle('gct-active', active);
        button.setAttribute('aria-pressed', String(active));
    });
}

function renderWordTags() {
    document.querySelectorAll('[data-gct-word-tags]').forEach((container) => {
        container.replaceChildren();
        settings.forbiddenWords.forEach((word) => {
            const tag = document.createElement('span');
            tag.className = 'gct-word-tag';
            const text = document.createElement('span');
            text.textContent = word;
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.dataset.gctRemoveWord = word;
            remove.setAttribute('aria-label', `${word} 삭제`);
            remove.textContent = '×';
            tag.append(text, remove);
            container.append(tag);
        });
    });
}

function addForbiddenWord(input) {
    const value = input.value.trim().replace(/,+$/, '').trim();
    if (!value) return;
    if (!settings.forbiddenWords.includes(value)) {
        settings.forbiddenWords.push(value);
        settings.forbiddenWords = normalizeWords(settings.forbiddenWords);
        saveSettings();
    }
    input.value = '';
    renderWordTags();
    updatePromptPreview();
}

function removeForbiddenWord(word) {
    settings.forbiddenWords = settings.forbiddenWords.filter((item) => item !== word);
    saveSettings();
    renderWordTags();
    updatePromptPreview();
}

function syncPromptFields() {
    document.querySelectorAll('[data-gct-setting]').forEach((field) => {
        field.value = settings[field.dataset.gctSetting] ?? '';
    });
}

function updatePromptPreview() {
    const preview = document.querySelector('#gct-prompt-preview');
    if (preview) preview.textContent = buildPrompt('', settings.mode, true);
}

function resetSettings() {
    if (!confirm('개떡찰떡 지시사항과 금지단어를 기본값으로 되돌릴까요?')) return;
    Object.assign(settings, cloneDefaults());
    saveSettings();
    syncPromptFields();
    syncModeButtons();
    renderWordTags();
    updatePromptPreview();
    toastr.success('기본값으로 되돌렸습니다.');
}

function bindSharedControls(root = document) {
    root.querySelectorAll('[data-gct-mode]').forEach((button) => {
        button.addEventListener('click', () => setMode(button.dataset.gctMode));
    });

    root.querySelectorAll('[data-gct-setting]').forEach((field) => {
        field.addEventListener('input', () => {
            settings[field.dataset.gctSetting] = field.value;
            document.querySelectorAll(`[data-gct-setting="${field.dataset.gctSetting}"]`).forEach((peer) => {
                if (peer !== field) peer.value = field.value;
            });
            saveSettings();
            updatePromptPreview();
        });
    });

    root.querySelectorAll('[data-gct-add-word]').forEach((button) => {
        button.addEventListener('click', () => {
            const editor = button.closest('[data-gct-word-editor]');
            addForbiddenWord(editor.querySelector('[data-gct-word-input]'));
        });
    });

    root.querySelectorAll('[data-gct-word-input]').forEach((input) => {
        input.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ',') {
                event.preventDefault();
                addForbiddenWord(input);
            }
        });
    });

    root.addEventListener('click', (event) => {
        const remove = event.target.closest('[data-gct-remove-word]');
        if (remove) removeForbiddenWord(remove.dataset.gctRemoveWord);
    });
}

function createComposerUI() {
    if (document.querySelector('#gct-root')) return;
    const sendForm = document.querySelector('#send_form');
    if (!sendForm) {
        console.warn('[개떡찰떡] #send_form을 찾지 못했습니다.');
        return;
    }

    const root = document.createElement('div');
    root.id = 'gct-root';
    root.innerHTML = `
        <section id="gct-panel" class="gct-panel" hidden>
            <header class="gct-panel-header">
                <img src="${ICON_PATH}" alt="" class="gct-panel-icon">
                <div class="gct-panel-heading">
                    <b>개떡찰떡</b>
                    <small>대필 없이, 쓴 문장만 찰떡같이</small>
                </div>
                <button type="button" class="gct-icon-button" id="gct-settings-toggle" aria-label="지시사항 설정" title="지시사항 설정">
                    <i class="fa-solid fa-gear"></i>
                </button>
                <button type="button" class="gct-icon-button" id="gct-panel-close" aria-label="닫기" title="닫기">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            </header>

            <div class="gct-mode-row" role="group" aria-label="다듬기 모드">
                <button type="button" data-gct-mode="light">살짝 교정</button>
                <button type="button" data-gct-mode="polish">찰떡으로</button>
            </div>

            <div id="gct-inline-settings" class="gct-inline-settings" hidden>
                <label>기본 지시사항<textarea data-gct-setting="basePrompt" rows="4"></textarea></label>
                <label>찰떡 지시사항<textarea data-gct-setting="polishPrompt" rows="4"></textarea></label>
                <label>안돼 지시사항<textarea data-gct-setting="forbiddenPrompt" rows="4"></textarea></label>
                <div class="gct-word-editor" data-gct-word-editor="panel">
                    <b>금지단어:</b>
                    <div class="gct-word-tags" data-gct-word-tags></div>
                    <input type="text" data-gct-word-input placeholder="단어 추가" autocomplete="off">
                    <button type="button" data-gct-add-word>추가</button>
                </div>
            </div>

            <label class="gct-editor-label" for="gct-source"><b>원문</b><small>직접 수정 가능</small></label>
            <textarea id="gct-source" class="gct-editor" rows="5" placeholder="현재 입력창 내용을 가져옵니다."></textarea>
            <button type="button" id="gct-process" class="gct-primary" data-gct-run>${getProcessLabel()}</button>
            <label class="gct-editor-label" for="gct-result"><b>결과</b><small>적용 전 편집 가능</small></label>
            <textarea id="gct-result" class="gct-editor gct-result" rows="5" placeholder="다듬은 결과가 여기에 표시됩니다."></textarea>
            <div class="gct-panel-actions">
                <button type="button" id="gct-panel-undo">되돌리기</button>
                <button type="button" id="gct-apply" class="gct-primary">입력창에 적용</button>
            </div>
        </section>

        <div id="gct-undo-bar" class="gct-undo-bar" hidden>
            <span>입력창에 적용됨</span>
            <button type="button" id="gct-quick-undo">되돌리기</button>
        </div>

        <div id="gct-launcher" class="gct-launcher">
            <button type="button" class="gct-launcher-label" id="gct-panel-toggle" aria-label="메시지 다듬기 탭 열기">
                <i class="fa-solid fa-chevron-up"></i>
                <span>메시지 다듬기</span>
            </button>
            <button type="button" class="gct-rice-button" data-gct-run aria-label="현재 입력을 바로 다듬어 적용" title="현재 입력을 바로 다듬어 적용">
                <img src="${ICON_PATH}" alt="">
            </button>
        </div>`;

    if (getComputedStyle(sendForm).position === 'static') {
        sendForm.style.setProperty('position', 'relative', 'important');
    }
    sendForm.append(root);
    bindSharedControls(root);
    syncPromptFields();
    syncModeButtons();
    renderWordTags();

    root.querySelector('.gct-rice-button').addEventListener('click', quickApply);
    root.querySelector('#gct-panel-toggle').addEventListener('click', togglePanel);
    root.querySelector('#gct-panel-close').addEventListener('click', closePanel);
    root.querySelector('#gct-process').addEventListener('click', processInPanel);
    root.querySelector('#gct-apply').addEventListener('click', applyPanelResult);
    root.querySelector('#gct-panel-undo').addEventListener('click', undoLast);
    root.querySelector('#gct-quick-undo').addEventListener('click', undoLast);
    root.querySelector('#gct-settings-toggle').addEventListener('click', () => {
        const inlineSettings = root.querySelector('#gct-inline-settings');
        inlineSettings.hidden = !inlineSettings.hidden;
    });
}

async function createSettingsUI() {
    if (document.querySelector('#gct-settings')) return;
    const { renderExtensionTemplateAsync } = getContext();
    const html = await renderExtensionTemplateAsync(EXTENSION_FOLDER, 'settings', { iconPath: ICON_PATH });
    if (!html) {
        console.warn('[개떡찰떡] 설정 템플릿을 불러오지 못했습니다.', { extensionFolder: EXTENSION_FOLDER });
        return;
    }
    document.querySelector('#extensions_settings2')?.insertAdjacentHTML('beforeend', html);

    const root = document.querySelector('#gct-settings');
    if (!root) return;
    bindSharedControls(root);
    root.querySelector('#gct-reset-settings')?.addEventListener('click', resetSettings);
    syncPromptFields();
    syncModeButtons();
    renderWordTags();
    updatePromptPreview();
}

async function initialize() {
    loadSettings();
    await createSettingsUI();
    createComposerUI();
}

const { eventSource, event_types } = getContext();
eventSource.on(event_types.APP_READY, initialize);
