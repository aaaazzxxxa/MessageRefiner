const MODULE_NAME = 'gaetteok_chaltteok';
const EXTENSION_BASE_URL = new URL('.', import.meta.url);
const EXTENSION_FOLDER = decodeURIComponent(EXTENSION_BASE_URL.pathname)
    .replace(/^.*\/scripts\/extensions\//, '')
    .replace(/\/$/, '');
const ICON_PATH = new URL('assets/gaetteok-chaltteok.png', EXTENSION_BASE_URL).href;
const CONNECTION_SERVICE_PATH = new URL('../../shared.js', EXTENSION_BASE_URL).href;

const SOURCE_HINTS = Object.freeze({
    light: '맞춤법, 띄어쓰기, 조사, 어순 등을 가볍게 바로잡습니다.',
    polish: '번역투와 어색한 표현, 문장 호흡과 리듬, 문체까지 더 자세히 다듬습니다.',
});

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
    connectionProfileId: '',
    widgetVisible: true,
    widgetPosition: null,
});

let settings;
let isBusy = false;
let lastUndo = null;
let undoTimer = null;
let debugEntries = [];
let sourceHintVisible = true;
let widgetResizeObserver = null;

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
    settings.connectionProfileId = typeof settings.connectionProfileId === 'string' ? settings.connectionProfileId : '';
    settings.widgetVisible = settings.widgetVisible !== false;
    settings.widgetPosition = normalizeWidgetPosition(settings.widgetPosition);
    return settings;
}

function saveSettings() {
    getContext().saveSettingsDebounced();
}

function normalizeWords(words) {
    if (!Array.isArray(words)) return [];
    return [...new Set(words.map((word) => String(word).trim()).filter(Boolean))];
}

function normalizeWidgetPosition(position) {
    if (!position || !Number.isFinite(position.left) || !Number.isFinite(position.top)) return null;
    return { left: Math.max(6, position.left), top: Math.max(6, position.top) };
}

function appendDebug(label, data = '') {
    const timestamp = new Date().toLocaleTimeString('ko-KR', { hour12: false });
    const detail = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    debugEntries.push(`[${timestamp}] ${label}${detail ? `\n${detail}` : ''}`);
    if (debugEntries.length > 80) debugEntries = debugEntries.slice(-80);
    renderDebugLog();
}

function renderDebugLog() {
    const field = document.querySelector('#gct-debug-log');
    if (!field) return;
    field.value = debugEntries.join('\n\n');
    field.scrollTop = field.scrollHeight;
}

function clearDebugLog() {
    debugEntries = [];
    renderDebugLog();
}

async function copyDebugLog() {
    const text = debugEntries.join('\n\n');
    if (!text) {
        toastr.info('복사할 디버그 로그가 없습니다.');
        return;
    }
    await navigator.clipboard.writeText(text);
    toastr.success('디버그 로그를 복사했습니다.');
}

function getConnectionProfiles() {
    const manager = getContext().extensionSettings.connectionManager;
    return Array.isArray(manager?.profiles) ? manager.profiles : [];
}

function getSelectedProfile() {
    if (!settings.connectionProfileId) return null;
    return getConnectionProfiles().find((profile) => profile.id === settings.connectionProfileId) ?? null;
}

function renderConnectionProfiles() {
    const select = document.querySelector('#gct-connection-profile');
    if (!select) return;
    const profiles = [...getConnectionProfiles()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
    select.replaceChildren(new Option('현재 SillyTavern 연결 사용', ''));
    profiles.forEach((profile) => select.add(new Option(profile.name, profile.id)));

    if (settings.connectionProfileId && !profiles.some((profile) => profile.id === settings.connectionProfileId)) {
        settings.connectionProfileId = '';
        saveSettings();
    }
    select.value = settings.connectionProfileId;
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
    const prompt = buildPrompt(source, mode);
    const profile = getSelectedProfile();
    appendDebug('요청 시작', {
        mode,
        connection: profile ? profile.name : '현재 SillyTavern 연결',
        prompt,
    });

    try {
        let raw;
        if (profile) {
            const { ConnectionManagerRequestService } = await import(CONNECTION_SERVICE_PATH);
            const response = await ConnectionManagerRequestService.sendRequest(
                profile.id,
                prompt,
                2048,
                { stream: false, extractData: true, includePreset: true, includeInstruct: true },
            );
            raw = response?.content ?? '';
        } else {
            const generateRaw = await getGenerateRaw();
            raw = await generateRaw({ prompt });
        }

        appendDebug('응답', raw);
        const result = cleanOutput(raw);
        if (!result) throw new Error('모델이 빈 결과를 반환했습니다.');
        return result;
    } catch (error) {
        appendDebug('오류', {
            message: error?.message || String(error),
            cause: error?.cause?.message || null,
            stack: error?.stack || null,
        });
        throw error;
    }
}

function setBusy(busy) {
    isBusy = busy;
    if (busy) closeQuickMenu();
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
    return settings.mode === 'light' ? '살짝 교정하기' : '찰떡 교정하기';
}

function getSourceHint(mode = settings.mode) {
    return SOURCE_HINTS[mode === 'light' ? 'light' : 'polish'];
}

function updateSourceHint(show = sourceHintVisible) {
    const source = document.querySelector('#gct-source');
    if (!source) return;
    sourceHintVisible = Boolean(show);
    source.placeholder = sourceHintVisible && !source.value ? getSourceHint() : '';
}

function setEditorSession(original, revised = '') {
    const source = document.querySelector('#gct-source');
    const result = document.querySelector('#gct-result');
    if (source) source.value = original ?? '';
    if (result) result.value = revised ?? '';
    updateSourceHint(false);
}

function clearEditor() {
    const source = document.querySelector('#gct-source');
    const result = document.querySelector('#gct-result');
    if (source) source.value = '';
    if (result) result.value = '';
    updateSourceHint(true);
}

function closeQuickMenu() {
    const menu = document.querySelector('#gct-quick-menu');
    const button = document.querySelector('.gct-rice-button');
    if (menu) menu.hidden = true;
    if (button) button.setAttribute('aria-expanded', 'false');
    document.querySelector('#gct-root')?.classList.remove('gct-menu-below');
}

function toggleQuickMenu() {
    const menu = document.querySelector('#gct-quick-menu');
    const button = document.querySelector('.gct-rice-button');
    if (!menu || !button || isBusy) return;
    const willOpen = menu.hidden;
    menu.hidden = !willOpen;
    button.setAttribute('aria-expanded', String(willOpen));
    if (willOpen) {
        const launcherRect = document.querySelector('#gct-launcher')?.getBoundingClientRect();
        if (launcherRect) {
            const spaceAbove = launcherRect.top - 6;
            const spaceBelow = window.innerHeight - launcherRect.bottom - 6;
            document.querySelector('#gct-root')?.classList.toggle(
                'gct-menu-below',
                menu.offsetHeight > spaceAbove && spaceBelow > spaceAbove,
            );
        }
    }
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
    document.querySelector('#gct-undo-bar')?.setAttribute('hidden', '');
    lastUndo = null;
    toastr.success('원래 입력으로 되돌렸습니다.');
}

async function quickApply(mode = settings.mode) {
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
        const original = input.value;
        const result = await refineText(source, mode);
        rememberUndo(input.value, result);
        setEditorSession(original, result);
        setInputValue(result);
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

function openPanel() {
    const panel = document.querySelector('#gct-panel');
    if (!panel) return;
    const source = document.querySelector('#gct-source');
    const result = document.querySelector('#gct-result');
    if (source && result && !source.value && !result.value) {
        const inputValue = getInput()?.value ?? '';
        if (inputValue) setEditorSession(inputValue, '');
        else updateSourceHint(true);
    }
    panel.hidden = false;
    document.querySelector('#gct-launcher')?.classList.add('gct-open');
    requestAnimationFrame(syncPanelPlacement);
    if (source?.value) source.focus();
}

function closePanel() {
    const panel = document.querySelector('#gct-panel');
    if (panel) panel.hidden = true;
    document.querySelector('#gct-launcher')?.classList.remove('gct-open');
    document.querySelector('#gct-root')?.classList.remove('gct-panel-below');
}

function togglePanel() {
    closeQuickMenu();
    const panel = document.querySelector('#gct-panel');
    if (!panel || panel.hidden) openPanel();
    else closePanel();
}

function syncWidgetVisibility() {
    const root = document.querySelector('#gct-root');
    const toggle = document.querySelector('#gct-widget-visible');
    if (root) root.hidden = !settings.widgetVisible;
    if (toggle) toggle.checked = settings.widgetVisible;
}

function setWidgetVisible(visible) {
    settings.widgetVisible = Boolean(visible);
    saveSettings();
    if (!settings.widgetVisible) {
        closePanel();
        closeQuickMenu();
    }
    syncWidgetVisibility();
    if (settings.widgetVisible) requestAnimationFrame(applyWidgetPosition);
}

function applyWidgetPosition() {
    const root = document.querySelector('#gct-root');
    const sendForm = document.querySelector('#send_form');
    const launcher = document.querySelector('#gct-launcher');
    if (!root || !launcher) return;

    const position = normalizeWidgetPosition(settings.widgetPosition);
    root.classList.toggle('gct-detached', Boolean(position));
    if (position) {
        root.style.removeProperty('width');
        const maxLeft = Math.max(6, window.innerWidth - root.offsetWidth - 6);
        const maxTop = Math.max(6, window.innerHeight - launcher.offsetHeight - 6);
        root.style.left = `${Math.min(position.left, maxLeft)}px`;
        root.style.top = `${Math.min(position.top, maxTop)}px`;
    } else if (sendForm) {
        const formRect = sendForm.getBoundingClientRect();
        const width = Math.min(formRect.width, window.innerWidth - 12);
        const left = Math.min(Math.max(6, formRect.left), Math.max(6, window.innerWidth - width - 6));
        const top = Math.max(6, formRect.top - launcher.offsetHeight - 4);
        root.style.width = `${width}px`;
        root.style.left = `${left}px`;
        root.style.top = `${top}px`;
    }

    syncPanelPlacement();
}

function syncPanelPlacement() {
    const root = document.querySelector('#gct-root');
    const panel = document.querySelector('#gct-panel');
    const launcher = document.querySelector('#gct-launcher');
    if (!root || !panel || !launcher || panel.hidden) {
        root?.classList.remove('gct-panel-below');
        return;
    }

    const launcherRect = launcher.getBoundingClientRect();
    const panelHeight = panel.offsetHeight;
    const spaceAbove = launcherRect.top - 6;
    const spaceBelow = window.innerHeight - launcherRect.bottom - 6;
    root.classList.toggle('gct-panel-below', panelHeight > spaceAbove && spaceBelow > spaceAbove);
}

function dockWidget() {
    settings.widgetPosition = null;
    saveSettings();
    applyWidgetPosition();
    toastr.success('입력창 위로 돌려놓았습니다.');
}

function startWidgetDrag(event) {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const root = document.querySelector('#gct-root');
    const launcher = document.querySelector('#gct-launcher');
    const handle = event.currentTarget;
    if (!root || !launcher) return;

    event.preventDefault();
    closeQuickMenu();
    const anchoredRect = root.getBoundingClientRect();
    if (!root.classList.contains('gct-detached')) {
        root.classList.add('gct-detached');
        root.style.removeProperty('width');
        const maxLeft = Math.max(6, window.innerWidth - root.offsetWidth - 6);
        root.style.left = `${Math.min(Math.max(6, anchoredRect.left), maxLeft)}px`;
        root.style.top = `${Math.max(6, anchoredRect.top)}px`;
    }

    const rootRect = root.getBoundingClientRect();
    const offsetX = event.clientX - rootRect.left;
    const offsetY = event.clientY - rootRect.top;
    handle.setPointerCapture(event.pointerId);
    root.classList.add('gct-dragging');

    const move = (moveEvent) => {
        const maxLeft = Math.max(6, window.innerWidth - root.offsetWidth - 6);
        const maxTop = Math.max(6, window.innerHeight - launcher.offsetHeight - 6);
        const left = Math.min(Math.max(6, moveEvent.clientX - offsetX), maxLeft);
        const top = Math.min(Math.max(6, moveEvent.clientY - offsetY), maxTop);
        root.style.left = `${left}px`;
        root.style.top = `${top}px`;
        syncPanelPlacement();
    };

    const finish = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', finish);
        handle.removeEventListener('pointercancel', finish);
        root.classList.remove('gct-dragging');
        settings.widgetPosition = {
            left: Number.parseFloat(root.style.left) || 6,
            top: Number.parseFloat(root.style.top) || 6,
        };
        saveSettings();
        syncPanelPlacement();
    };

    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
}

function setMode(mode) {
    settings.mode = mode === 'light' ? 'light' : 'polish';
    saveSettings();
    syncModeButtons();
    updatePromptPreview();
    const processButton = document.querySelector('#gct-process');
    if (processButton && !isBusy) processButton.textContent = getProcessLabel();
    const source = document.querySelector('#gct-source');
    updateSourceHint(!source?.value);
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
    if (!value) return false;
    if (!settings.forbiddenWords.includes(value)) {
        settings.forbiddenWords.push(value);
        settings.forbiddenWords = normalizeWords(settings.forbiddenWords);
        saveSettings();
    }
    input.value = '';
    renderWordTags();
    updatePromptPreview();
    return true;
}

function setWordEditorActive(editor, active) {
    const input = editor.querySelector('[data-gct-word-input]');
    const button = editor.querySelector('[data-gct-add-word]');
    editor.classList.toggle('gct-adding', active);
    button.textContent = active ? '확인' : '+ 단어 추가';
    button.setAttribute('aria-expanded', String(active));
    if (active) {
        input.focus();
    } else {
        input.value = '';
    }
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

function resetPromptSettings() {
    if (!confirm('개떡찰떡 지시사항과 금지단어를 기본값으로 되돌릴까요?')) return;
    settings.mode = DEFAULT_SETTINGS.mode;
    settings.basePrompt = DEFAULT_SETTINGS.basePrompt;
    settings.polishPrompt = DEFAULT_SETTINGS.polishPrompt;
    settings.forbiddenPrompt = DEFAULT_SETTINGS.forbiddenPrompt;
    settings.forbiddenWords = [];
    saveSettings();
    syncPromptFields();
    syncModeButtons();
    renderWordTags();
    updatePromptPreview();
    const processButton = document.querySelector('#gct-process');
    if (processButton && !isBusy) processButton.textContent = getProcessLabel();
    const source = document.querySelector('#gct-source');
    updateSourceHint(!source?.value);
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
            const input = editor.querySelector('[data-gct-word-input]');
            if (!editor.classList.contains('gct-adding')) {
                setWordEditorActive(editor, true);
                return;
            }
            if (addForbiddenWord(input)) setWordEditorActive(editor, false);
            else input.focus();
        });
    });

    root.querySelectorAll('[data-gct-word-input]').forEach((input) => {
        input.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ',') {
                event.preventDefault();
                if (addForbiddenWord(input)) {
                    setWordEditorActive(input.closest('[data-gct-word-editor]'), false);
                }
            } else if (event.key === 'Escape') {
                event.preventDefault();
                setWordEditorActive(input.closest('[data-gct-word-editor]'), false);
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
            </header>

            <div class="gct-mode-row" role="group" aria-label="다듬기 모드">
                <button type="button" data-gct-mode="light">살짝 교정</button>
                <button type="button" data-gct-mode="polish">찰떡 교정</button>
            </div>

            <div id="gct-inline-settings" class="gct-inline-settings" hidden>
                <label>기본 지시사항<textarea data-gct-setting="basePrompt" rows="4"></textarea></label>
                <label>찰떡 지시사항<textarea data-gct-setting="polishPrompt" rows="4"></textarea></label>
                <label>안돼 지시사항<textarea data-gct-setting="forbiddenPrompt" rows="4"></textarea></label>
                <div class="gct-word-editor" data-gct-word-editor="panel">
                    <b>금지단어:</b>
                    <div class="gct-word-tags" data-gct-word-tags></div>
                    <input type="text" class="gct-word-input" data-gct-word-input placeholder="단어" autocomplete="off">
                    <button type="button" class="gct-add-word" data-gct-add-word>+ 단어 추가</button>
                </div>
                <div class="gct-inline-settings-actions">
                    <button type="button" id="gct-reset-prompts">기본값 복원</button>
                </div>
                <details class="gct-preview-details">
                    <summary>실제 전송 프롬프트 미리보기</summary>
                    <pre id="gct-prompt-preview"></pre>
                </details>
            </div>

            <div class="gct-editor-label">
                <label for="gct-source"><b>원문</b></label>
                <div class="gct-editor-tools">
                    <small>직접 수정 가능</small>
                    <button type="button" id="gct-clear" class="gct-clear-button">비우기</button>
                </div>
            </div>
            <textarea id="gct-source" class="gct-editor" rows="5"></textarea>
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

        <div id="gct-quick-menu" class="gct-quick-menu" role="menu" hidden>
            <button type="button" data-gct-quick-mode="light" data-gct-run role="menuitem">
                <b>살짝 교정</b>
                <small>맞춤법·조사·어순만 가볍게</small>
            </button>
            <button type="button" data-gct-quick-mode="polish" data-gct-run role="menuitem">
                <b>찰떡 교정</b>
                <small>문장 호흡·표현·문체까지</small>
            </button>
        </div>

        <div id="gct-launcher" class="gct-launcher">
            <div class="gct-drag-handle" id="gct-launcher-drag" role="button" tabindex="0" aria-label="메시지 다듬기 탭 이동" title="끌어서 탭 이동">
                <i class="fa-solid fa-grip-vertical"></i>
            </div>
            <button type="button" class="gct-launcher-label" id="gct-panel-toggle" aria-label="메시지 다듬기 탭 열기">
                <i class="fa-solid fa-chevron-up"></i>
                <span>메시지 다듬기</span>
            </button>
            <button type="button" class="gct-launcher-control gct-dock-button" id="gct-dock" aria-label="입력창 위로 돌려놓기" title="입력창 위로 돌려놓기">
                <i class="fa-solid fa-thumbtack"></i>
            </button>
            <button type="button" class="gct-launcher-control" id="gct-widget-close" aria-label="개떡찰떡 탭 숨기기" title="탭 숨기기">
                <i class="fa-solid fa-xmark"></i>
            </button>
            <button type="button" class="gct-rice-button" data-gct-run aria-label="빠른 교정 방식 선택" title="빠른 교정 방식 선택" aria-controls="gct-quick-menu" aria-expanded="false">
                <img src="${ICON_PATH}" alt="">
            </button>
        </div>`;

    root.hidden = !settings.widgetVisible;
    document.body.append(root);
    bindSharedControls(root);
    syncPromptFields();
    syncModeButtons();
    renderWordTags();
    updateSourceHint(true);
    applyWidgetPosition();
    syncWidgetVisibility();

    root.querySelector('.gct-rice-button').addEventListener('click', toggleQuickMenu);
    root.querySelectorAll('[data-gct-quick-mode]').forEach((button) => {
        button.addEventListener('click', () => {
            const mode = button.dataset.gctQuickMode;
            closeQuickMenu();
            setMode(mode);
            quickApply(mode);
        });
    });
    root.querySelector('#gct-panel-toggle').addEventListener('click', togglePanel);
    root.querySelector('#gct-widget-close').addEventListener('click', () => setWidgetVisible(false));
    root.querySelector('#gct-dock').addEventListener('click', dockWidget);
    root.querySelector('#gct-launcher-drag').addEventListener('pointerdown', startWidgetDrag);
    root.querySelector('#gct-reset-prompts').addEventListener('click', resetPromptSettings);
    root.querySelector('#gct-clear').addEventListener('click', clearEditor);
    root.querySelector('#gct-process').addEventListener('click', processInPanel);
    root.querySelector('#gct-apply').addEventListener('click', applyPanelResult);
    root.querySelector('#gct-panel-undo').addEventListener('click', undoLast);
    root.querySelector('#gct-quick-undo').addEventListener('click', undoLast);
    root.querySelector('#gct-source').addEventListener('focus', () => updateSourceHint(false));
    root.querySelector('#gct-source').addEventListener('input', () => updateSourceHint(false));
    root.querySelector('#gct-settings-toggle').addEventListener('click', () => {
        const inlineSettings = root.querySelector('#gct-inline-settings');
        inlineSettings.hidden = !inlineSettings.hidden;
        updatePromptPreview();
    });

    document.addEventListener('pointerdown', (event) => {
        if (!event.target.closest('#gct-quick-menu, .gct-rice-button')) closeQuickMenu();
    });

    if (typeof ResizeObserver === 'function') {
        widgetResizeObserver?.disconnect();
        widgetResizeObserver = new ResizeObserver(() => {
            if (!settings.widgetPosition) applyWidgetPosition();
        });
        widgetResizeObserver.observe(sendForm);
    }
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
    root.querySelector('#gct-widget-visible').addEventListener('change', (event) => {
        setWidgetVisible(event.target.checked);
    });
    root.querySelector('#gct-connection-profile').addEventListener('change', (event) => {
        settings.connectionProfileId = event.target.value;
        saveSettings();
        const profile = getSelectedProfile();
        appendDebug('연결 프로필 변경', profile?.name || '현재 SillyTavern 연결');
    });
    root.querySelector('#gct-copy-debug').addEventListener('click', () => {
        copyDebugLog().catch((error) => toastr.error(error?.message || '로그를 복사하지 못했습니다.'));
    });
    root.querySelector('#gct-clear-debug').addEventListener('click', clearDebugLog);
    syncWidgetVisibility();
    renderConnectionProfiles();
    renderDebugLog();
}

async function initialize() {
    loadSettings();
    await createSettingsUI();
    createComposerUI();
    appendDebug('개떡찰떡 시작', { version: '0.1.0-beta.6' });
    window.addEventListener('resize', applyWidgetPosition);
    window.addEventListener('scroll', applyWidgetPosition, true);
}

const { eventSource, event_types } = getContext();
eventSource.on(event_types.APP_READY, initialize);
[
    event_types.CONNECTION_PROFILE_CREATED,
    event_types.CONNECTION_PROFILE_UPDATED,
    event_types.CONNECTION_PROFILE_DELETED,
    event_types.CONNECTION_PROFILE_LOADED,
].filter(Boolean).forEach((eventType) => eventSource.on(eventType, renderConnectionProfiles));
