// Stands in for `wpctl` and `pw-dump` (the first argument says which), over a
// JSON file ($FAKE_PIPEWIRE) instead of PipeWire: the nodes, their linear
// channel volume and mute, and the defaults. `pw-dump --monitor` prints the
// graph, then a node's update whenever the file changes. Every wpctl call is
// logged to $FAKE_PIPEWIRE.log.
import { appendFileSync, readFileSync, watchFile, writeFileSync } from "node:fs";

export interface FakeNode {
  id: number;
  name: string;
  description: string;
  kind: "Sink" | "Source";
  /** Linear, as PipeWire keeps it: wpctl's 0.5 is 0.125. */
  linear: number;
  mute: boolean;
}

export interface FakeGraph {
  nodes: FakeNode[];
  sink?: string;
  source?: string;
}

const file = process.env.FAKE_PIPEWIRE!;
const read = (): FakeGraph => JSON.parse(readFileSync(file, "utf8"));
const [tool, ...args] = process.argv.slice(2);

const dump = (graph: FakeGraph) => [
  { id: 0, type: "PipeWire:Interface:Core", info: { props: {} } },
  ...graph.nodes.map((node) => ({
    id: node.id,
    type: "PipeWire:Interface:Node",
    info: {
      props: { "media.class": `Audio/${node.kind}`, "node.name": node.name, "node.description": node.description },
      params: { Props: [{ volume: 1, mute: node.mute, channelVolumes: [node.linear, node.linear] }, {}] },
    },
  })),
  {
    id: 42,
    type: "PipeWire:Interface:Metadata",
    props: { "metadata.name": "default" },
    metadata: [
      ...(graph.sink ? [{ subject: 0, key: "default.audio.sink", value: { name: graph.sink } }] : []),
      ...(graph.source ? [{ subject: 0, key: "default.audio.source", value: { name: graph.source } }] : []),
    ],
  },
];
const print = (objects: unknown[]) => process.stdout.write(`${JSON.stringify(objects, null, 2)}\n`);

if (tool === "pw-dump") {
  print(dump(read()));
  if (args.includes("--monitor")) {
    // A client came and went (what pw-dump and wpctl themselves do): nothing to read again.
    print([{ id: 90, type: "PipeWire:Interface:Client", info: { props: {} } }]);
    watchFile(file, { interval: 20 }, () => {
      print(dump(read()).filter((object) => object.type !== "PipeWire:Interface:Core"));
    });
  }
} else if (tool === "wpctl") {
  appendFileSync(`${file}.log`, `${args.join(" ")}\n`);
  const graph = read();
  const [command, target, value] = args;
  const node = graph.nodes.find((node) =>
    target === "@DEFAULT_AUDIO_SINK@" ? node.name === graph.sink
    : target === "@DEFAULT_AUDIO_SOURCE@" ? node.name === graph.source
    : node.id === Number(target),
  );
  if (!node) {
    process.stderr.write(`Object '${target}' not found\n`);
    process.exit(1);
  }
  if (command === "set-volume") {
    const limit = args.includes("--limit") ? Number(args[args.indexOf("--limit") + 1]) : Infinity;
    const now = Math.cbrt(node.linear);
    const step = value!.match(/^(\d+)%([+-])$/);
    let next = step ? now + (step[2] === "+" ? 1 : -1) * (Number(step[1]) / 100) : Number(value);
    next = Math.max(0, Math.min(next, limit));
    node.linear = next ** 3;
  } else if (command === "set-mute") {
    node.mute = value === "toggle" ? !node.mute : value === "1";
  } else if (command === "set-default") {
    if (node.kind === "Sink") graph.sink = node.name;
    else graph.source = node.name;
  }
  writeFileSync(file, JSON.stringify(graph));
}
