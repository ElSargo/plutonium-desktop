// Plutonium test IME: letters compose, Space or Enter commits (a few words
// convert, like a pinyin or kana IME), Backspace edits the composition,
// Escape cancels it, and "-" with nothing composed deletes the character
// before the cursor in the app's text.
const words = { nihao: "你好", ni: "你", hao: "好", nihon: "日本" };
let contextID = -1;
let composing = "";

chrome.input.ime.onFocus.addListener((context) => {
  contextID = context.contextID;
  composing = "";
  console.log("focus", JSON.stringify(context));
});

chrome.input.ime.onBlur.addListener(() => {
  contextID = -1;
  composing = "";
});

function compose() {
  if (composing) {
    chrome.input.ime.setComposition({ contextID, text: composing, cursor: composing.length });
  } else {
    chrome.input.ime.clearComposition({ contextID });
  }
}

chrome.input.ime.onKeyEvent.addListener((engineID, key) => {
  if (key.type !== "keydown" || key.ctrlKey || key.altKey || contextID < 0) return false;
  if (/^[a-z]$/.test(key.key)) {
    composing += key.key;
    compose();
    return true;
  }
  if (composing && (key.key === " " || key.key === "Enter")) {
    chrome.input.ime.commitText({ contextID, text: words[composing] ?? composing });
    composing = "";
    return true;
  }
  if (composing && key.key === "Backspace") {
    composing = composing.slice(0, -1);
    compose();
    return true;
  }
  if (composing && key.key === "Escape") {
    composing = "";
    compose();
    return true;
  }
  if (!composing && key.key === "-") {
    chrome.input.ime.deleteSurroundingText({ engineID, contextID, offset: -1, length: 1 });
    return true;
  }
  return false;
});
