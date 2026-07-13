/* prefs.js
 *
 * Preferences UI for Bluetooth Desktop Widget.
 * Exposes a single choice: list layout vs circular-ring layout.
 */

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';

import { ExtensionPreferences } from 'resource:///org/gnome/shell/extensions/prefs.js';

export default class BluetoothDesktopWidgetPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        let settings = this.getSettings('org.gnome.shell.extensions.bluetooth-desktop-widget');

        let page = new Adw.PreferencesPage({
            title: 'General',
            icon_name: 'bluetooth-active-symbolic',
        });

        let group = new Adw.PreferencesGroup({
            title: 'Appearance',
            description: 'Choose how connected devices are displayed on the desktop widget',
        });
        page.add(group);

        let row = new Adw.ComboRow({
            title: 'Widget style',
            subtitle: '"Circles" mimics the iOS battery widget look',
            model: new Gtk.StringList({ strings: ['List', 'Circles'] }),
        });

        // Sync initial selection from current setting.
        let current = settings.get_string('widget-style');
        row.selected = current === 'list' ? 0 : 1;

        row.connect('notify::selected', () => {
            let value = row.selected === 0 ? 'list' : 'circles';
            settings.set_string('widget-style', value);
        });

        group.add(row);
        window.add(page);
    }
}