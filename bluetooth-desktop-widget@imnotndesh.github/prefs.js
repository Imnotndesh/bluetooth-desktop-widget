import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import GLib from 'gi://GLib';
import Secret from 'gi://Secret';
import Soup from 'gi://Soup?version=3.0';

import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const SETTINGS_SCHEMA = 'org.gnome.shell.extensions.bluetooth-desktop-widget';
const SETTINGS_KEY_WIDGETS_CONFIG = 'widgets-config';


const WIDGET_CATALOG = [
    {
        id: 'bluetooth',
        name: 'Bluetooth',
        icon: 'bluetooth-active-symbolic',
        implemented: true,
        buildSettings: buildBluetoothSettingsGroup,
    },
    {
        id: 'weather',
        name: 'Weather',
        icon: 'weather-few-clouds-symbolic',
        implemented: true,
        buildSettings: buildWeatherSettingsGroup,
    },
    {
        id: 'photos',
        name: 'Photos (Immich)',
        icon: 'image-x-generic-symbolic',
        implemented: true,
        buildSettings: buildPhotosSettingsGroup,
    },
    {
        id: 'clock',
        name: 'Analog Clock',
        icon: 'preferences-system-time-symbolic',
        implemented: true,
        buildSettings: null,
    },
    {
        id: 'storage',
        name: 'Storage',
        icon: 'drive-harddisk-symbolic',
        implemented: true,
        buildSettings: buildStorageSettingsGroup,
    },
];

function catalogEntry(id) {
    return WIDGET_CATALOG.find((w) => w.id === id);
}

function loadConfig(settings) {
    let raw = settings.get_string(SETTINGS_KEY_WIDGETS_CONFIG);
    let config = [];
    try {
        let parsed = JSON.parse(raw);
        if (Array.isArray(parsed))
            config = parsed.filter((e) => catalogEntry(e.id));
    } catch (e) {
        logError(e, 'Desktop Widgets prefs: corrupt widgets-config, resetting');
    }

    for (let entry of WIDGET_CATALOG) {
        if (!config.some((e) => e.id === entry.id))
            config.push({ id: entry.id, enabled: false });
    }

    return config;
}

function saveConfig(settings, config) {
    settings.set_string(SETTINGS_KEY_WIDGETS_CONFIG, JSON.stringify(config));
}

function buildWidgetsListGroup(settings, window) {
    let group = new Adw.PreferencesGroup({
        title: 'Widgets',
        description: 'Choose which widgets appear on the desktop and in what order',
    });

    function render() {
        for (let row of [...(group._rows || [])])
            group.remove(row);
        group._rows = [];

        let config = loadConfig(settings);

        config.forEach((entry, index) => {
            let meta = catalogEntry(entry.id);

            let row = new Adw.ActionRow({
                title: meta.name,
                subtitle: meta.implemented ? '' : 'Coming soon',
                sensitive: meta.implemented,
            });
            row.add_prefix(new Gtk.Image({ icon_name: meta.icon, pixel_size: 20 }));

            let controls = new Gtk.Box({
                orientation: Gtk.Orientation.HORIZONTAL,
                spacing: 6,
                valign: Gtk.Align.CENTER,
            });

            let upButton = new Gtk.Button({
                icon_name: 'go-up-symbolic',
                valign: Gtk.Align.CENTER,
                sensitive: meta.implemented && index > 0,
                css_classes: ['flat'],
            });
            upButton.connect('clicked', () => {
                let cfg = loadConfig(settings);
                [cfg[index - 1], cfg[index]] = [cfg[index], cfg[index - 1]];
                saveConfig(settings, cfg);
                render();
            });

            let downButton = new Gtk.Button({
                icon_name: 'go-down-symbolic',
                valign: Gtk.Align.CENTER,
                sensitive: meta.implemented && index < config.length - 1,
                css_classes: ['flat'],
            });
            downButton.connect('clicked', () => {
                let cfg = loadConfig(settings);
                [cfg[index], cfg[index + 1]] = [cfg[index + 1], cfg[index]];
                saveConfig(settings, cfg);
                render();
            });

            let toggle = new Gtk.Switch({
                active: entry.enabled,
                valign: Gtk.Align.CENTER,
                sensitive: meta.implemented,
            });
            toggle.connect('notify::active', () => {
                let cfg = loadConfig(settings);
                cfg[index].enabled = toggle.active;
                saveConfig(settings, cfg);
            });

            controls.append(upButton);
            controls.append(downButton);
            controls.append(toggle);
            row.add_suffix(controls);
            row.activatable_widget = toggle;

            group.add(row);
            group._rows.push(row);
        });
    }

    group._rows = [];
    render();

    return group;
}


function buildBluetoothSettingsGroup(settings) {
    let group = new Adw.PreferencesGroup({
        title: 'Bluetooth',
        description: 'Configure the Bluetooth widget',
    });

    let row = new Adw.ComboRow({
        title: 'Widget style',
        subtitle: '"Circles" mimics the iOS battery widget look',
        model: new Gtk.StringList({ strings: ['List', 'Circles'] }),
    });

    let current = settings.get_string('widget-style');
    row.selected = current === 'list' ? 0 : 1;

    row.connect('notify::selected', () => {
        settings.set_string('widget-style', row.selected === 0 ? 'list' : 'circles');
    });

    group.add(row);
    return group;
}

function buildWeatherSettingsGroup(settings) {
    let group = new Adw.PreferencesGroup({
        title: 'Weather',
        description: 'Powered by Open-Meteo — free, no API key required',
    });

    let row = new Adw.EntryRow({
        title: 'Location',
    });
    row.set_text(settings.get_string('weather-location'));

    row.connect('changed', () => {
        settings.set_string('weather-location', row.get_text());
    });

    group.add(row);

    let hint = new Adw.ActionRow({
        subtitle: 'Enter a city name, e.g. "Berlin" or "Austin, US". Leave blank to default to London.',
    });
    group.add(hint);

    return group;
}

// --- Immich (Photos widget) helpers -----------------------------------
//
// The API key is deliberately kept out of GSettings/dconf (which is not
// encrypted at rest) and instead stored in the user's system keyring via
// libsecret, looked up by instance URL.

const PHOTOS_SECRET_SCHEMA = new Secret.Schema(
    'org.gnome.shell.extensions.bluetooth-desktop-widget.photos',
    Secret.SchemaFlags.NONE,
    { 'instance-url': Secret.SchemaAttributeType.STRING }
);

function storeApiKey(instanceUrl, apiKey) {
    Secret.password_store(
        PHOTOS_SECRET_SCHEMA,
        { 'instance-url': instanceUrl },
        Secret.COLLECTION_DEFAULT,
        'Immich API Key',
        apiKey,
        null,
        (source, result) => {
            try {
                Secret.password_store_finish(result);
            } catch (e) {
                logError(e, 'Desktop Widgets prefs: failed to store Immich API key');
            }
        }
    );
}

function lookupApiKey(instanceUrl, callback) {
    if (!instanceUrl) {
        callback(null);
        return;
    }
    Secret.password_lookup(
        PHOTOS_SECRET_SCHEMA,
        { 'instance-url': instanceUrl },
        null,
        (source, result) => {
            let apiKey = null;
            try {
                apiKey = Secret.password_lookup_finish(result);
            } catch (e) {
                logError(e, 'Desktop Widgets prefs: failed to look up Immich API key');
            }
            callback(apiKey);
        }
    );
}

function immichRequest(url, apiKey, callback) {
    let session = new Soup.Session();
    session.timeout = 10;
    let message = Soup.Message.new('GET', url);
    if (!message) {
        callback(false, `Invalid URL: ${url}`);
        return;
    }
    message.request_headers.append('x-api-key', apiKey);
    message.request_headers.append('Accept', 'application/json');

    session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (session_, result) => {
        try {
            let bytes = session_.send_and_read_finish(result);
            let status = message.get_status();
            if (status !== Soup.Status.OK) {
                callback(false, `Server responded with HTTP ${status}`);
                return;
            }
            let text = new TextDecoder('utf-8').decode(bytes.get_data());
            callback(true, JSON.parse(text));
        } catch (e) {
            callback(false, e.message);
        }
    });
}

function testImmichConnection(url, apiKey, callback) {
    immichRequest(`${url}/api/users/me`, apiKey, (ok, data) => {
        if (!ok) {
            callback(false, data);
            return;
        }
        callback(true, data.name || data.email || 'user');
    });
}

function fetchImmichAlbums(url, apiKey, callback) {
    immichRequest(`${url}/api/albums`, apiKey, (ok, data) => {
        if (!ok) {
            callback(false, data);
            return;
        }
        callback(true, data);
    });
}

function buildPhotosSettingsGroup(settings) {
    let group = new Adw.PreferencesGroup({
        title: 'Photos (Immich)',
        description: 'Connect to your Immich server and choose an album to display',
    });

    let urlRow = new Adw.EntryRow({ title: 'Server URL' });
    urlRow.set_text(settings.get_string('photos-instance-url'));
    group.add(urlRow);

    let keyRow = new Adw.PasswordEntryRow({ title: 'API Key' });
    group.add(keyRow);

    let existingUrl = settings.get_string('photos-instance-url');
    if (existingUrl) {
        lookupApiKey(existingUrl, (key) => {
            if (key)
                keyRow.set_text(key);
        });
    }

    let statusRow = new Adw.ActionRow({ title: 'Status', subtitle: 'Not connected' });
    group.add(statusRow);

    let testButton = new Gtk.Button({
        label: 'Test Connection',
        valign: Gtk.Align.CENTER,
        css_classes: ['suggested-action'],
    });
    let testRow = new Adw.ActionRow({ title: 'Connect' });
    testRow.add_suffix(testButton);
    testRow.activatable_widget = testButton;
    group.add(testRow);

    let albumComboRow = new Adw.ComboRow({
        title: 'Album',
        subtitle: 'Shown as a slideshow on the desktop widget',
        visible: false,
    });
    group.add(albumComboRow);

    let albumsData = [];
    let suppressAlbumSignal = false;

    function populateAlbums(url, apiKey) {
        statusRow.subtitle = 'Loading albums…';
        fetchImmichAlbums(url, apiKey, (ok, albumsOrError) => {
            if (!ok) {
                statusRow.subtitle = `Connected, but failed to load albums: ${albumsOrError}`;
                return;
            }
            if (albumsOrError.length === 0) {
                statusRow.subtitle = 'Connected — no albums found on this server';
                albumComboRow.visible = false;
                return;
            }

            statusRow.subtitle = 'Connected';
            albumsData = albumsOrError;

            suppressAlbumSignal = true;
            albumComboRow.model = new Gtk.StringList({
                strings: albumsData.map((a) => `${a.albumName} (${a.assetCount} photos)`),
            });

            let currentAlbumId = settings.get_string('photos-album-id');
            let idx = albumsData.findIndex((a) => a.id === currentAlbumId);
            albumComboRow.selected = idx >= 0 ? idx : 0;
            suppressAlbumSignal = false;

            albumComboRow.visible = true;

            // If nothing was previously selected, save the default selection.
            if (idx < 0) {
                let album = albumsData[0];
                settings.set_string('photos-album-id', album.id);
                settings.set_string('photos-album-name', album.albumName);
            }
        });
    }

    testButton.connect('clicked', () => {
        let url = urlRow.get_text().trim().replace(/\/+$/, '');
        let apiKey = keyRow.get_text().trim();

        if (!url || !apiKey) {
            statusRow.subtitle = 'Please enter both a server URL and an API key';
            return;
        }

        testButton.sensitive = false;
        statusRow.subtitle = 'Testing…';

        testImmichConnection(url, apiKey, (ok, userOrError) => {
            testButton.sensitive = true;

            if (!ok) {
                statusRow.subtitle = `Connection failed: ${userOrError}`;
                albumComboRow.visible = false;
                return;
            }

            settings.set_string('photos-instance-url', url);
            storeApiKey(url, apiKey);
            statusRow.subtitle = `Connected as ${userOrError}`;

            populateAlbums(url, apiKey);
        });
    });

    albumComboRow.connect('notify::selected', () => {
        if (suppressAlbumSignal)
            return;
        let album = albumsData[albumComboRow.selected];
        if (!album)
            return;
        settings.set_string('photos-album-id', album.id);
        settings.set_string('photos-album-name', album.albumName);
    });

    // If we already have a saved URL + key, try to populate albums right away.
    if (existingUrl) {
        lookupApiKey(existingUrl, (key) => {
            if (key)
                populateAlbums(existingUrl, key);
        });
    }

    let hint = new Adw.ActionRow({
        subtitle: 'Generate an API key in Immich under Account Settings → API Keys. The key is stored in your system keyring, not in plain settings.',
    });
    group.add(hint);

    return group;
}

function buildStorageSettingsGroup(settings) {
    let group = new Adw.PreferencesGroup({
        title: 'Storage',
        description: 'Configure the Storage widget',
    });

    let row = new Adw.EntryRow({
        title: 'Mount path',
    });
    row.set_text(settings.get_string('storage-mount-path') || '/');

    row.connect('changed', () => {
        let text = row.get_text().trim();
        settings.set_string('storage-mount-path', text || '/');
    });

    group.add(row);

    let hint = new Adw.ActionRow({
        subtitle: 'Filesystem path to report usage for, e.g. "/" or "/home".',
    });
    group.add(hint);

    return group;
}

export default class DesktopWidgetsPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        let settings = this.getSettings(SETTINGS_SCHEMA);

        let page = new Adw.PreferencesPage({
            title: 'General',
            icon_name: 'preferences-desktop-symbolic',
        });

        page.add(buildWidgetsListGroup(settings, window));

        for (let meta of WIDGET_CATALOG) {
            if (meta.implemented && meta.buildSettings)
                page.add(meta.buildSettings(settings));
        }

        window.add(page);
        window.set_default_size(480, 600);
    }
}