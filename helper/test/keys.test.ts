import assert from "node:assert/strict";
import { test } from "node:test";
import { commitRuns, comboKeys, layoutOf, textKeys, typingRuns } from "../src/keys.ts";

const codes = (runs: ReturnType<typeof commitRuns>) =>
  runs.map((run) => run.filter((event) => event.type === "keyDown").map((event) => event.code).join(" "));

test("keys are sent in runs that end after each Tab or Enter", () => {
  assert.deepEqual(codes(commitRuns(textKeys("a\t\tB\n"))), ["KeyA Tab", "Tab", "ShiftLeft KeyB Enter"]);
  // shift+Tab: the run ends once shift is up too.
  const back = commitRuns(comboKeys("shift+Tab").concat(comboKeys("x")));
  assert.deepEqual(codes(back), ["ShiftLeft Tab", "KeyX"]);
  assert.equal(back[0]!.at(-1)!.code, "ShiftLeft");
  assert.deepEqual(codes(commitRuns(textKeys("abc"))), ["KeyA KeyB KeyC"]);
});

// A German layout's keymap, cut down to what the tests touch (as
// xkb_keymap_get_as_string writes it).
const KEYMAP = `xkb_keymap {
xkb_keycodes "evdev+aliases(qwertz)" {
\tminimum = 8;
\tmaximum = 255;
\t<AE02>               = 11;
\t<AD06>               = 29;
\t<AD11>               = 34;
\t<AB01>               = 52;
\t<FK13>               = 191;
\t<FK14>               = 192;
};

xkb_types "complete" {
\tvirtual_modifiers NumLock,Alt,LevelThree;
};

xkb_symbols "pc+de+inet(evdev)" {
\tname[group1]="German";

\tkey <AE02>               {      [               2,        quotedbl,     twosuperior,       oneeighth ] };
\tkey <AD06>               {      [               z,               Z,       leftarrow,             yen ] };
\tkey <FK13>               {      [         XF86Tools ] };
\tkey <AB01>               {      [               y,               Y,  guillemotright,       U203A ] };
};

};
`;
const DE = layoutOf(KEYMAP, [
  { text: "2", code: "Digit2", modifiers: 0 },
  { text: '"', code: "Digit2", modifiers: 8 },
  { text: "²", code: "Digit2", modifiers: 16 },
  { text: "z", code: "KeyY", modifiers: 0 },
  { text: "Z", code: "KeyY", modifiers: 8 },
  { text: "y", code: "KeyZ", modifiers: 0 },
  { text: "ü", code: "BracketLeft", modifiers: 0 },
  { text: " ", code: "Space", modifiers: 0 },
]);

test("text goes through the session's layout, with AltGr as a modifier alone", () => {
  const [run, ...rest] = typingRuns('zy"²ü\n', DE);
  assert.equal(rest.length, 0);
  assert.equal(run!.keymap, undefined);
  const downs = run!.events.filter((event) => event.type === "keyDown");
  assert.deepEqual(
    downs.map((event) => `${event.code}:${event.modifiers}`),
    ["KeyY:0", "KeyZ:0", "ShiftLeft:8", "Digit2:8", "Digit2:16", "BracketLeft:0", "Enter:0"],
  );
  // ctrl+z is the key that types z.
  assert.deepEqual(
    comboKeys("ctrl+z", DE).map((event) => event.code),
    ["ControlLeft", "KeyY", "KeyY", "ControlLeft"],
  );
  assert.deepEqual(
    comboKeys("ctrl+Z", DE).filter((event) => event.type === "keyDown").map((event) => event.code),
    ["ControlLeft", "KeyY"],
  );
});

test("characters the layout lacks go on spare keys of a temporary keymap", () => {
  const runs = typingRuns("zé€é", DE);
  assert.equal(runs.length, 1);
  const { keymap, events } = runs[0]!;
  assert.deepEqual(
    events.filter((event) => event.type === "keyDown").map((event) => event.code),
    ["KeyY", "F13", "F14", "F13"],
  );
  assert.match(keymap!, /key <FK13> \{ type= "ONE_LEVEL", symbols\[1\]= \[ U00E9 \] \};/);
  assert.match(keymap!, /key <FK14> \{ type= "ONE_LEVEL", symbols\[1\]= \[ U20AC \] \};/);
  assert.doesNotMatch(keymap!, /XF86Tools/);
  // The rest is the session's.
  assert.match(keymap!, /key <AE02> .*twosuperior/);
  assert.match(keymap!, /\n\};\n\n\};\n$/);
  // Three characters for two spare keys: a second run, with its own keymap.
  const split = typingRuns("éa€bß", layoutOf(KEYMAP, [{ text: "a", code: "KeyA", modifiers: 0 }, { text: "b", code: "KeyB", modifiers: 0 }]));
  assert.equal(split.length, 2);
  assert.match(split[1]!.keymap!, /<FK13> \{ type= "ONE_LEVEL", symbols\[1\]= \[ U00DF \] \}/);
  assert.throws(() => typingRuns("é", layoutOf("", [])), /no key for it/);
  assert.throws(() => typingRuns("é"), /US keyboard/);
});
