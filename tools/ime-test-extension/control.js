// Opened by tools/ime-test.sh: makes this extension (or ?id=<input method
// id>, e.g. the US keyboard back) the current input method. Needs
// --allowlisted-extension-id=<this extension's id> for inputMethodPrivate.
chrome.inputMethodPrivate.setCurrentInputMethod(
  new URLSearchParams(location.search).get("id") ??
    `_ext_ime_${chrome.runtime.id}pltest`,
  () => {
    document.title = chrome.runtime.lastError
      ? `error: ${chrome.runtime.lastError.message}`
      : "current";
  },
);
