/* extension.js
 *
 * Bluetooth Desktop Widget
 * -------------------------
 * Floating desktop widget listing connected Bluetooth devices with their
 * battery level. Two layouts, switchable via prefs:
 *   - "list"    : rounded card, one row per device (icon + name + battery)
 *   - "circles" : iOS-battery-widget-style row of circular rings
 *
 * Everything — D-Bus/BlueZ logic, widget construction, styling, and the
 * ring drawing — lives in this single file on purpose (no lib/ folder, no
 * external stylesheet), per extensions.gnome.org review requirements about
 * unreachable files.
 */

import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const BLUEZ_SERVICE = 'org.bluez';
const OM_IFACE = 'org.freedesktop.DBus.ObjectManager';
const PROPS_IFACE = 'org.freedesktop.DBus.Properties';
const DEVICE_IFACE = 'org.bluez.Device1';
const BATTERY_IFACE = 'org.bluez.Battery1';

const SETTINGS_SCHEMA = 'org.gnome.shell.extensions.bluetooth-desktop-widget';
const SETTINGS_KEY_STYLE = 'widget-style'; // "list" | "circles"

// Map BlueZ's "Icon" property hint -> a symbolic icon name that ships
// with GNOME's icon theme, so we don't need to bundle any icon assets.
const ICON_MAP = {
    'audio-headset': 'audio-headphones-symbolic',
    'audio-headphones': 'audio-headphones-symbolic',
    'audio-card': 'audio-speakers-symbolic',
    'input-gaming': 'input-gaming-symbolic',
    'input-mouse': 'input-mouse-symbolic',
    'input-keyboard': 'input-keyboard-symbolic',
    'input-tablet': 'input-tablet-symbolic',
    'phone': 'phone-symbolic',
    'computer': 'computer-symbolic',
};
const FALLBACK_ICON = 'bluetooth-active-symbolic';

function iconNameFor(hint) {
    return ICON_MAP[hint] || FALLBACK_ICON;
}

// Round a battery percentage down to the nearest 10 to pick a
// battery-level-N-symbolic icon (GNOME ships these in steps of 10,
// from battery-level-0-symbolic to battery-level-100-symbolic).
function batteryIconFor(percentage) {
    let level = Math.max(0, Math.min(100, Math.round(percentage / 10) * 10));
    return `battery-level-${level}-symbolic`;
}

function unpackVariantDict(dict) {
    let out = {};
    for (let key in dict)
        out[key] = dict[key].deep_unpack();
    return out;
}

// A circular ring gauge drawn with Cairo, mimicking the iOS battery-widget
// look: dark track, green progress arc starting at 12 o'clock, symbolic
// device icon centered inside.
const RING_SIZE = 68;
const RING_LINE_WIDTH = 5;

function buildRingActor(percentage, iconName) {
    let container = new St.Widget({
        layout_manager: new Clutter.BinLayout(),
        width: RING_SIZE,
        height: RING_SIZE,
    });

    let area = new St.DrawingArea({ width: RING_SIZE, height: RING_SIZE });
    area.connect('repaint', (a) => {
        let cr = a.get_context();
        let [w, h] = a.get_surface_size();
        let cx = w / 2;
        let cy = h / 2;
        let radius = Math.min(w, h) / 2 - RING_LINE_WIDTH / 2 - 1;

        // Track (full circle, dim)
        cr.setSourceRGBA(1, 1, 1, 0.15);
        cr.setLineWidth(RING_LINE_WIDTH);
        cr.arc(cx, cy, radius, 0, 2 * Math.PI);
        cr.stroke();

        // Progress arc, starting at 12 o'clock, clockwise
        let fraction = Math.max(0, Math.min(1, (percentage || 0) / 100));
        let startAngle = -Math.PI / 2;
        let endAngle = startAngle + fraction * 2 * Math.PI;

        cr.setSourceRGBA(0.20, 0.84, 0.29, 1); // iOS-green
        cr.setLineWidth(RING_LINE_WIDTH);
        cr.setLineCap(0); // butt cap, closer to reference image
        cr.arc(cx, cy, radius, startAngle, endAngle);
        cr.stroke();

        cr.$dispose();
    });

    let icon = new St.Icon({
        icon_name: iconName,
        icon_size: 22,
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
        style: 'color: rgba(255,255,255,0.92);',
    });

    container.add_child(area);
    container.add_child(icon);

    return container;
}

function buildCircleCell(info) {
    let cell = new St.BoxLayout({
        vertical: true,
        x_align: Clutter.ActorAlign.CENTER,
        style: 'spacing: 6px; padding: 4px 10px;',
    });

    let ring = buildRingActor(info.percentage, iconNameFor(info.icon));
    cell.add_child(ring);

    let label = new St.Label({
        text: typeof info.percentage === 'number' ? `${info.percentage}%` : '—',
        x_align: Clutter.ActorAlign.CENTER,
        style: `
            color: rgba(255,255,255,0.92);
            font-size: 15px;
            font-weight: 500;
        `,
    });
    cell.add_child(label);

    return cell;
}

function buildListRow(info) {
    let row = new St.BoxLayout({
        style: 'padding: 8px 6px; spacing: 10px;',
    });

    let icon = new St.Icon({
        icon_name: iconNameFor(info.icon),
        icon_size: 22,
        style: 'color: rgba(255,255,255,0.85);',
    });

    let name = new St.Label({
        text: info.name,
        y_align: Clutter.ActorAlign.CENTER,
        style: 'color: rgba(255,255,255,0.92); font-size: 13px;',
        x_expand: true,
    });

    let battery = new St.BoxLayout({
        y_align: Clutter.ActorAlign.CENTER,
        style: 'spacing: 4px;',
    });

    if (typeof info.percentage === 'number') {
        let batteryIcon = new St.Icon({
            icon_name: batteryIconFor(info.percentage),
            icon_size: 16,
            style: 'color: rgba(255,255,255,0.75);',
        });
        let batteryLabel = new St.Label({
            text: `${info.percentage}%`,
            y_align: Clutter.ActorAlign.CENTER,
            style: 'color: rgba(255,255,255,0.65); font-size: 12px;',
        });
        battery.add_child(batteryIcon);
        battery.add_child(batteryLabel);
    }

    row.add_child(icon);
    row.add_child(name);
    row.add_child(battery);

    return row;
}

export default class BluetoothDesktopWidgetExtension extends Extension {
    enable() {
        this._bus = Gio.DBus.system;
        this._devices = new Map(); // path -> { name, icon, connected, percentage }
        this._signalId = null;
        this._settings = this.getSettings(SETTINGS_SCHEMA);
        this._settingsChangedId = this._settings.connect(
            `changed::${SETTINGS_KEY_STYLE}`,
            () => this._redraw()
        );

        this._buildWidget();
        this._refreshFromBus();
        this._subscribeToChanges();
    }

    disable() {
        if (this._signalId !== null) {
            this._bus.signal_unsubscribe(this._signalId);
            this._signalId = null;
        }

        if (this._settings && this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }

        if (this._widget) {
            Main.layoutManager._backgroundGroup.remove_child(this._widget);
            this._widget.destroy();
            this._widget = null;
        }

        this._bus = null;
        this._devices = null;
        this._contentBox = null;
        this._emptyLabel = null;
        this._settings = null;
    }

    // ---------- UI ----------

    _buildWidget() {
        // Outer card. Frosted-glass look: try a real backdrop blur via
        // Shell.BlurEffect first (this blurs whatever is behind the actor,
        // like iOS/macOS vibrancy), falling back to plain translucency if
        // that API isn't available on this Shell version.
        this._widget = new St.BoxLayout({
            vertical: true,
            reactive: true,
            style: `
                background-color: rgba(28, 28, 30, 0.55);
                border-radius: 20px;
                border: 1px solid rgba(255,255,255,0.08);
                padding: 14px;
                min-width: 260px;
            `,
        });

        try {
            let blur = new Shell.BlurEffect({
                brightness: 0.65,
                sigma: 40,
                mode: Shell.BlurMode.BACKGROUND,
            });
            this._widget.add_effect(blur);
        } catch (e) {
            // Blur API not available on this Shell version — the
            // translucent background-color above still gives a reasonable
            // glass-ish look on its own.
            logError(e, 'Bluetooth Desktop Widget: blur effect unavailable, using plain translucency');
        }

        let title = new St.Label({
            text: 'Bluetooth',
            style: `
                font-weight: 700;
                font-size: 15px;
                color: rgba(255,255,255,0.92);
                padding-bottom: 8px;
                padding-left: 4px;
            `,
        });
        this._widget.add_child(title);

        this._contentBox = new St.Widget({ layout_manager: new Clutter.BinLayout() });
        this._widget.add_child(this._contentBox);

        this._emptyLabel = new St.Label({
            text: 'No devices connected',
            style: `
                color: rgba(255,255,255,0.5);
                font-size: 13px;
                padding: 6px 4px;
            `,
        });
        this._widget.add_child(this._emptyLabel);

        // Background group = below normal windows, same layer GNOME's
        // desktop-icons extension uses, unlike addChrome() which always
        // floats above everything.
        Main.layoutManager._backgroundGroup.add_child(this._widget);

        this._widget.set_position(
            Main.layoutManager.primaryMonitor.width - 320,
            60
        );
    }

    _redraw() {
        if (!this._contentBox)
            return;

        this._contentBox.destroy_all_children();

        let connected = [...this._devices.entries()]
            .filter(([, info]) => info.connected);

        if (connected.length === 0) {
            this._emptyLabel.show();
            this._contentBox.hide();
            return;
        }

        this._emptyLabel.hide();
        this._contentBox.show();

        let style = this._settings ? this._settings.get_string(SETTINGS_KEY_STYLE) : 'circles';

        if (style === 'circles') {
            let row = new St.BoxLayout({ style: 'spacing: 4px;' });
            for (let [, info] of connected)
                row.add_child(buildCircleCell(info));
            this._contentBox.add_child(row);
        } else {
            let list = new St.BoxLayout({ vertical: true });
            for (let [, info] of connected)
                list.add_child(buildListRow(info));
            this._contentBox.add_child(list);
        }
    }

    // ---------- BlueZ / D-Bus ----------

    _refreshFromBus() {
        let result;
        try {
            result = this._bus.call_sync(
                BLUEZ_SERVICE,
                '/',
                OM_IFACE,
                'GetManagedObjects',
                null,
                GLib.VariantType.new('(a{oa{sa{sv}}})'),
                Gio.DBusCallFlags.NONE,
                -1,
                null
            );
        } catch (e) {
            logError(e, 'Bluetooth Desktop Widget: failed to reach BlueZ');
            return;
        }

        let objects = result.deep_unpack()[0];

        for (let path in objects) {
            let ifaces = objects[path];
            if (!(DEVICE_IFACE in ifaces))
                continue;

            let props = unpackVariantDict(ifaces[DEVICE_IFACE]);
            let batteryProps = BATTERY_IFACE in ifaces
                ? unpackVariantDict(ifaces[BATTERY_IFACE])
                : null;

            this._devices.set(path, {
                name: props.Name || props.Alias || path,
                icon: props.Icon || '',
                connected: !!props.Connected,
                percentage: batteryProps ? batteryProps.Percentage : undefined,
            });
        }

        this._redraw();
    }

    _subscribeToChanges() {
        this._signalId = this._bus.signal_subscribe(
            BLUEZ_SERVICE,
            PROPS_IFACE,
            'PropertiesChanged',
            null,
            null,
            Gio.DBusSignalFlags.NONE,
            (connection, sender, path, iface, signal, params) => {
                let [changedIface, changedProps] = params.deep_unpack();

                if (changedIface !== DEVICE_IFACE && changedIface !== BATTERY_IFACE)
                    return;

                let info = this._devices.get(path) || {
                    name: path,
                    icon: '',
                    connected: false,
                    percentage: undefined,
                };

                for (let key in changedProps) {
                    let value = changedProps[key].deep_unpack();

                    if (key === 'Connected') {
                        info.connected = value;
                        if (value)
                            this._readBatteryOnce(path, info);
                    } else if (key === 'Name' || key === 'Alias') {
                        info.name = value;
                    } else if (key === 'Icon') {
                        info.icon = value;
                    } else if (key === 'Percentage') {
                        info.percentage = value;
                    }
                }

                this._devices.set(path, info);
                this._redraw();
            }
        );
    }

    _readBatteryOnce(path, info) {
        try {
            let result = this._bus.call_sync(
                BLUEZ_SERVICE,
                path,
                PROPS_IFACE,
                'Get',
                new GLib.Variant('(ss)', [BATTERY_IFACE, 'Percentage']),
                GLib.VariantType.new('(v)'),
                Gio.DBusCallFlags.NONE,
                -1,
                null
            );
            let value = result.deep_unpack()[0].deep_unpack();
            info.percentage = value;
            this._devices.set(path, info);
            this._redraw();
        } catch (e) {
            // Device may not expose Battery1 yet right after reconnect —
            // that's fine, it'll arrive later via PropertiesChanged.
        }
    }
}