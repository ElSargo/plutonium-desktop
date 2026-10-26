// What the services on the system bus share (network.ts, bluetooth.ts): the
// bus's address, Properties calls, and asking the user through a shell.
import { DBusConnection, DBusError } from "../dbus.ts";

export const SYSTEM_BUS = process.env.PLUTONIUM_SYSTEM_BUS || "unix:path=/run/dbus/system_bus_socket";
export const PROPERTIES = "org.freedesktop.DBus.Properties";
export const OBJECT_MANAGER = "org.freedesktop.DBus.ObjectManager";

/** An object's properties on one interface (variants arrive as their values). */
export type Props = Map<string, unknown>;

/**
 * Asks the user something for a service, through the visible shell that may
 * use it (a Wi-Fi password, a pairing PIN): `detail` has `title`, `message`,
 * `fields` ([{ name, label, type }]) and `acceptLabel` for the library's
 * prompt, and the request's own facts. Resolves to the field values (`{}` for
 * a yes), null if the user said no, or undefined if no shell could ask.
 * `signal` takes the question back.
 */
export type AskUser = (
  kind: string,
  detail: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<Record<string, unknown> | null | undefined>;

export interface SystemBusOptions {
  /** The bus (tests: a FakeBus's); the system bus otherwise. */
  readonly address?: string;
  readonly ask?: AskUser;
}

export async function getAll(bus: DBusConnection, destination: string, path: string, iface: string): Promise<Props> {
  const [props] = await bus.call({
    destination,
    path,
    interface: PROPERTIES,
    member: "GetAll",
    signature: "s",
    body: [iface],
  });
  return props as Props;
}

export async function setProperty(
  bus: DBusConnection,
  destination: string,
  path: string,
  iface: string,
  name: string,
  value: readonly [string, unknown],
): Promise<void> {
  await bus.call({ destination, path, interface: PROPERTIES, member: "Set", signature: "ssv", body: [iface, name, value] });
}

export async function addMatch(bus: DBusConnection, rule: string): Promise<void> {
  await bus.call({
    destination: "org.freedesktop.DBus",
    path: "/org/freedesktop/DBus",
    interface: "org.freedesktop.DBus",
    member: "AddMatch",
    signature: "s",
    body: [rule],
  });
}

/** Whether `name` has an owner on the bus. */
export async function hasOwner(bus: DBusConnection, name: string): Promise<boolean> {
  const [has] = await bus.call({
    destination: "org.freedesktop.DBus",
    path: "/org/freedesktop/DBus",
    interface: "org.freedesktop.DBus",
    member: "NameHasOwner",
    signature: "s",
    body: [name],
  });
  return has === true;
}

/** A D-Bus error's last word ("org.bluez.Error.AuthenticationFailed" → "AuthenticationFailed"). */
export function errorWord(error: unknown): string {
  return error instanceof DBusError ? (error.errorName.split(".").pop() ?? "") : "";
}

/** A byte array (an SSID) as text. */
export function bytesText(value: unknown): string {
  return Array.isArray(value) ? Buffer.from(value as number[]).toString("utf8") : "";
}
