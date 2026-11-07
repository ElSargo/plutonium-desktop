import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";

// The dock's view (dock.js) over a small DOM: a press on a slot starts a
// possible drag, and what matters is which button the click lands on. A
// browser sends no click to a button replaced since the press.

class FakeElement extends EventTarget {
  tagName: string;
  className = "";
  textContent = "";
  innerHTML = "";
  dataset: Record<string, string> = {};
  style = { setProperty() {} };
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  classList = {
    add: (...names: string[]) => { for (const name of names) if (!this.names().includes(name)) this.className += ` ${name}`; },
    remove: () => {},
    toggle: () => {},
    contains: (name: string) => this.names().includes(name),
  };
  constructor(tag: string) {
    super();
    this.tagName = tag;
  }
  names() { return this.className.split(" ").filter(Boolean); }
  get isConnected(): boolean { return this === body || !!this.parent?.isConnected; }
  setAttribute() {}
  getAttribute() { return null; }
  getBoundingClientRect() { return { left: 0, right: 100, top: 0, bottom: 30, width: 30, height: 30 }; }
  append(...nodes: FakeElement[]) { for (const node of nodes) { node.remove(); node.parent = this; this.children.push(node); } }
  after() {}
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this); this.parent = null; }
  replaceChildren(...nodes: FakeElement[]) { for (const child of [...this.children]) child.remove(); this.append(...nodes); }
  cloneNode() { return new FakeElement(this.tagName); }
  querySelectorAll(): FakeElement[] { return this.children.filter((child) => child.dataset.dockSlot); }
}

const body = new FakeElement("body");
const windowEvents = new EventTarget();
Object.assign(globalThis, {
  document: { head: new FakeElement("head"), body, createElement: (tag: string) => new FakeElement(tag) },
  Element: FakeElement,
  addEventListener: windowEvents.addEventListener.bind(windowEvents),
  removeEventListener: windowEvents.removeEventListener.bind(windowEvents),
  innerWidth: 1000,
  innerHeight: 1000,
});

// @ts-ignore: the browser's library, plain JavaScript.
const { mountDock } = await import("../web/ui/dock/dock.js");

const pointer = (type: string, x = 0, y = 0, buttons = 1) => Object.assign(new Event(type), { button: 0, buttons, clientX: x, clientY: y, shiftKey: false });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function mounted() {
  const pressed: number[] = [];
  const moved: [number, number][] = [];
  const view = {
    pinned: [0, 1].map((index) => ({ index, slot: { id: `s${index}`, target: { kind: "terminal" }, scope: "thread", layout: "split" }, things: [] as { kind: string; entry: { id: number } }[], state: "idle" })),
    running: [],
  };
  const dock = Object.assign(new EventTarget(), {
    host: {},
    view: () => view,
    setting: () => null,
    activate: async (index: number) => { pressed.push(index); },
    move: (from: number, to: number) => moved.push([from, to]),
    changed: () => dock.dispatchEvent(new Event("change")),
  });
  const container = new FakeElement("div");
  body.append(container);
  const mount = mountDock(container, dock, { icons: {}, addButton: false });
  const buttons = () => mount.root.children as FakeElement[];
  const press = (button: FakeElement) => button.dispatchEvent(pointer("pointerdown"));
  /** The release as a browser sends it: pointerup, then click on the button pressed, if it's still there. */
  const release = (button: FakeElement) => {
    windowEvents.dispatchEvent(pointer("pointerup", 0, 0, 0));
    if (button.isConnected) button.dispatchEvent(pointer("click", 0, 0, 0));
  };
  return { mount, dock, view, buttons, press, release, pressed, moved };
}

describe("a press on a slot", () => {
  beforeEach(() => { body.children = []; });

  test("is a click: it reaches the button it began on", async () => {
    const { buttons, press, release, pressed } = mounted();
    const button = buttons()[1];
    press(button);
    release(button);
    assert.deepEqual(pressed, [1]);
    await tick();
    assert.equal(buttons()[1], button, "nothing changed: the button stays");
  });

  test("a change during the press waits for the click", async () => {
    const { dock, view, buttons, press, release, pressed } = mounted();
    const button = buttons()[0];
    press(button);
    view.pinned[0].state = "focused";
    view.pinned[0].things = [{ kind: "window", entry: { id: 1 } }];
    dock.changed();
    assert.equal(buttons()[0], button);
    release(button);
    assert.deepEqual(pressed, [0]);
    await tick();
    assert.notEqual(buttons()[0], button, "drawn once the click is through");
    assert.ok(buttons()[0].classList.contains("focused"));
  });

  test("past the threshold it's a drag: the dock draws as it goes, and the slot moves", () => {
    const { buttons, press, moved } = mounted();
    const button = buttons()[1];
    press(button);
    windowEvents.dispatchEvent(pointer("pointermove", 20, 5));
    assert.notEqual(buttons()[1], button);
    windowEvents.dispatchEvent(pointer("pointerup", 20, 5, 0));
    assert.equal(moved.length, 1);
  });

  test("an app dragged from elsewhere still shows where it goes", () => {
    const { mount, buttons } = mounted();
    const before = buttons()[0];
    mount.showDrop(0);
    assert.notEqual(buttons()[0], before);
    assert.ok(buttons()[0].classList.contains("drop-before"));
    mount.showDrop(null);
    assert.ok(!buttons()[0].classList.contains("drop-before"));
  });
});
