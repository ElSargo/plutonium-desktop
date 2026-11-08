// Marks every frame it runs in, from the isolated world (the DOM is shared).
document.documentElement.setAttribute("data-probe-cs", "manifest");
chrome.runtime.sendMessage({ kind: "cs", url: location.href }).catch(() => {});
