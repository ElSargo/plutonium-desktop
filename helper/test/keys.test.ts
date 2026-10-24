import assert from "node:assert/strict";
import { test } from "node:test";
import { commitRuns, comboKeys, textKeys } from "../src/keys.ts";

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
