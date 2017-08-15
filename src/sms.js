/**
 * sms.js - A simple dialog for sending SMS messages with MConnect/KDE Connect
 * with (optional) Google Contacts auto-completion via Gnome Online Accounts.
 *
 * A great deal of credit and appreciation is owed to the indicator-kdeconnect
 * developers for the sister Python script 'Sms.py':
 * 
 * https://github.com/Bajoja/indicator-kdeconnect/blob/master/src/sms/Sms.py
 */

const Lang = imports.lang;
const System = imports.system;
const Gettext = imports.gettext.domain("gnome-shell-extension-mconnect");
const _ = Gettext.gettext;
const Folks = imports.gi.Folks;
const GdkPixbuf = imports.gi.GdkPixbuf;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

// Local Imports
function getPath() {
    // Diced from: https://github.com/optimisme/gjs-examples/
    let m = new RegExp("@(.+):\\d+").exec((new Error()).stack.split("\n")[1]);
    return Gio.File.new_for_path(m[1]).get_parent().get_path();
}

imports.searchPath.push(getPath());

const KDEConnect = imports.kdeconnect;
const MConnect = imports.mconnect;
const { initTranslations, Me, Resources, Settings } = imports.lib;

const ServiceProvider = {
    MCONNECT: 0,
    KDECONNECT: 1
};

initTranslations();

/** A Gtk.EntryCompletion subclass for Google Contacts */
const ContactCompletion = new Lang.Class({
    Name: "ContactCompletion",
    Extends: Gtk.EntryCompletion,
    
    _init: function () {
        this.parent();
        
        // Track suggested completions
        this._matched = [];
        this._last = null;
        
        // Phone number icons
        let theme = Gtk.IconTheme.get_default()
        this.phone_number_default = theme.load_icon("phone-number-default", 0, 0);
        this.phone_number_home = theme.load_icon("phone-number-home", 0, 0);
        this.phone_number_mobile = theme.load_icon("phone-number-mobile", 0, 0);
        this.phone_number_work = theme.load_icon("phone-number-work", 0, 0);
        
        // Define a completion model
        let listStore = new Gtk.ListStore();
        listStore.set_column_types([
            GObject.TYPE_STRING,    // Title
            GObject.TYPE_STRING,    // Phone Number
            GdkPixbuf.Pixbuf        // Type Icon
        ]);
        listStore.set_sort_column_id(0, Gtk.SortType.ASCENDING);
        //listStore.set_sort_func(1, this._sort, null, null);
        this.set_model(listStore);
        
        // Title
        this.set_text_column(0);
        // Type Icon
        let typeCell = new Gtk.CellRendererPixbuf();
        this.pack_start(typeCell, false);
        this.add_attribute(typeCell, "pixbuf", 2);
        
        this.set_match_func(Lang.bind(this, this._match), null, null);
        this.connect("match-selected", Lang.bind(this, this._select));
        
        if (Folks !== undefined) {
            this._get_contacts();
            this._has_contacts = true;
        } else {
            this._has_contacts = true;
        }
    },
    
    _get_contacts: function () {
        let [res, pid, in_fd, out_fd, err_fd] = GLib.spawn_async_with_pipes(
            GLib.getenv('HOME'),            // working dir
            ["python3", Me.path + "/folks.py"], // argv
            null,                           // envp
            GLib.SpawnFlags.SEARCH_PATH,    // enables PATH
            null                            // child_setup (func)
        );

        let stream = new Gio.DataInputStream({
            base_stream: new Gio.UnixInputStream({ fd: out_fd })
        });
        
        this._read_contact(stream);
    },
    
    _read_contact: function (stream) {
        stream.read_line_async(GLib.PRIORITY_LOW, null, (source, res) => {
            let [contact, length] = source.read_line_finish(res);
            
            if (contact !== null) {
                let [name, number, type] = contact.toString().split("\t");
                if (type !== "fax") { this._add_contact(name, number, type); }
                this._read_contact(stream);
            }
        });
    },
    
    _add_contact: function (name, number, type) {
        // Append the number to the title column
        let title = name + " <" + number + ">";
        
        // Phone Type Icon
        // TODO: folks->voice === google->work?
        if (type === "home") {
            type = this.phone_number_home;
        } else if (type === "cell") {
            type = this.phone_number_mobile;
        } else if (type === "work" || type === "voice") {
            type = this.phone_number_work;
        } else {
            type = this.phone_number_default;
        }
    
        this.model.set(
            this.model.append(),
            [0, 1, 2],
            [title, number, type]
        );
    },
    
    _match: function (completion, key, tree_iter) {
        let model = completion.get_model();
        let title = model.get_value(tree_iter, 0).toLowerCase();
        let number = model.get_value(tree_iter, 1);
        let oldContacts = key.split(",").slice(0, -1);
        
        // Set key to the last or only search item, trimmed of whitespace
        if (key.indexOf(",") > -1) { key = key.split(",").pop().trim(); }
        // Return if key is empty or this contact has already been added
        if (!key.length || oldContacts.indexOf(title) > -1) { return false; }
        // Clear current matches if the key has changed and reset last key
        if (key !== this._last) {
            this._matched = [];
            this._last = key;
        }
        
        if (this._matched.length >= 20) { return false; }
        
        // Match title (eg. "Name (type)") and number
        if (title.indexOf(key) > -1 || number.indexOf(key) > -1) {
            this._matched.push(model.get_string_from_iter(tree_iter));
            return true;
        }
    },
    
    _select: function (completion, model, tree_iter) {
        let entry = completion.get_entry();
        let oldContacts = entry.text.split(",").slice(0, -1);
        let newContact = model.get_value(tree_iter, 0);
        
        // Ignore duplicate selections
        if (oldContacts.indexOf(newContact) > -1) { return; }
        
        entry.set_text(
            oldContacts.join(", ")
            + ((oldContacts.length) ? ", " : "")
            + newContact + ", "
        );
        
        entry.set_position(-1);
        this._matched = [];
        
        return true;
    },
    
    // https://gist.github.com/andrei-m/982927#gistcomment-2059365
    _sort: function (model, a, b, user_data) {
	    var tmp;
	    if (a.length === 0) { return b.length; }
	    if (b.length === 0) { return a.length; }
	    if (a.length > b.length) { tmp = a; a = b; b = tmp; }

	    var i, j, res, alen = a.length, blen = b.length, row = Array(alen);
	    for (i = 0; i <= alen; i++) { row[i] = i; }

	    for (i = 1; i <= blen; i++) {
		    res = i;
		    for (j = 1; j <= alen; j++) {
			    tmp = row[j - 1];
			    row[j - 1] = res;
			    res = b[i - 1] === a[j - 1] ? tmp : Math.min(tmp + 1, Math.min(res + 1, row[j] + 1));
		    }
	    }
	    return res;
        
    }
});

/** A Gtk.Entry subclass for contact names and phone numbers */
const ContactEntry = new Lang.Class({
    Name: "ContactEntry",
    Extends: Gtk.SearchEntry,
    
    _init: function () {
        this.parent({
            hexpand: true,
            placeholder_text: _("Type a phone number"),
            primary_icon_name: "call-start-symbolic",
            primary_icon_activatable: false,
            primary_icon_sensitive: true,
            input_purpose: Gtk.InputPurpose.PHONE,
            completion: new ContactCompletion()
        });
        
        if (this.completion._has_contacts) {
            this.placeholder_text = _("Type a phone number or name");
            this.primary_icon_name = "avatar-default-symbolic";
            this.input_purpose = Gtk.InputPurpose.FREE_FORM;
        }
    
        // Select the first completion suggestion on "activate"
        this.connect("activate", () => { this._select(this); });
        
        // Remove error class on "changed"
        this.connect("changed", (entry) => {
            entry.secondary_icon_name = "";
            let styleContext = entry.get_style_context();
            
            if (styleContext.has_class("error")) {
                styleContext.remove_class("error");
            }
        });
    },
    
    _select: function (entry) {
        let completion = entry.get_completion();
        
        if (completion._matched.length > 0) {
            let iter_path = completion._matched["0"];
            let [b, iter] = completion.model.get_iter_from_string(iter_path);
            let oldContacts = entry.text.split(",").slice(0, -1);
            let newContact = completion.model.get_value(iter, 1);
        
            // Ignore duplicate selections
            if (oldContacts.indexOf(newContact) > -1) { return; }
        
            entry.set_text(
                oldContacts.join(", ")
                + ((oldContacts.length) ? ", " : "")
                + newContact + ", "
            );
        
            entry.set_position(-1);
            completion._matched = [];
        }
    }
});

/** SMS Window */
const ApplicationWindow = new Lang.Class({
    Name: "ApplicationWindow",
    Extends: Gtk.ApplicationWindow,
    
    _init: function(application, device) {
        this.parent({
            application: application,
            title: "MConnect",
            default_width: 300,
            default_height: 300,
            icon_name: "phone"
        });
        
        this.device = device;
        
        // User name
        this.user_name = GLib.get_real_name();
        if (this.user_name === "Unknown") {
            this.user_name = GLib.get_user_name();
        }
        
        // Contact Entry
        this.contactEntry = new ContactEntry();
        this.device.bind_property(
            "reachable",
            this.contactEntry,
            "sensitive",
            GObject.BindingFlags.DEFAULT
        );
        
        // HeaderBar
        this.set_titlebar(
            new Gtk.HeaderBar({
                custom_title: this.contactEntry,
                show_close_button: true
            })
        );
        
        // Content
        this.layout = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            margin: 6,
            spacing: 6
        });
        this.add(this.layout);
        
        // InfoBar
        this.infoBar = new Gtk.InfoBar({
            message_type: Gtk.MessageType.WARNING
        });
        this.infoBar.get_content_area().add(
            new Gtk.Image({ icon_name: "dialog-warning-symbolic" })
        );
        this.infoBar.get_content_area().add(
            new Gtk.Label({ label: _("Device is offline") })
        );
        
        // Content -> Conversation View
        // TODO: intercept notifications to fake a two-way conversation
        let scrolledWindow = new Gtk.ScrolledWindow({
            can_focus: false,
            hexpand: true,
            vexpand: true
        });
        this.layout.add(scrolledWindow);
        
        let conversationFrame = new Gtk.Frame();
        scrolledWindow.add(conversationFrame);
        
        this.conversationBuffer = new Gtk.TextBuffer();
        
        let conversationView = new Gtk.TextView({
            hexpand: true,
            vexpand: true,
            cursor_visible: false,
            editable: false,
            wrap_mode: Gtk.WrapMode.WORD,
            buffer: this.conversationBuffer
        });
        
        this.device.bind_property(
            "reachable",
            conversationView,
            "sensitive",
            GObject.BindingFlags.DEFAULT
        );
        conversationFrame.add(conversationView);
        
        // Content -> Message Entry
        this.messageEntry = new Gtk.Entry({
            hexpand: true,
            placeholder_text: _("Type an SMS message"),
            //secondary_icon_name: "mail-reply-sender-symbolic",
            secondary_icon_name: "send-sms",
            secondary_icon_activatable: true,
            secondary_icon_sensitive: false
        });
        
        this.messageEntry.connect("changed", (entry, signal_id, data) => {
            entry.secondary_icon_sensitive = (entry.text.length) ? true : false;
        });
        
        this.messageEntry.connect("activate", (entry, signal_id, data) => {
            this.send(entry, signal_id, data);
        });
        
        this.messageEntry.connect("icon-release", (entry, signal_id, data) => {
            this.send(entry, signal_id, data);
        });
        
        this.device.bind_property(
            "reachable",
            this.messageEntry,
            "sensitive",
            GObject.BindingFlags.DEFAULT
        );
        
        this.layout.add(this.messageEntry);
        
        // Device Status
        // See: https://bugzilla.gnome.org/show_bug.cgi?id=710888
        this.device.connect("notify::reachable", () => {
            if (!this.device.reachable) {
                this.layout.add(this.infoBar);
                this.layout.reorder_child(this.infoBar, 0);
                this.infoBar.show_all();
            } else if (this.device.reachable) {
                this.infoBar.hide();
                this.layout.remove(this.infoBar);
            }
        });
        
        // Finish initing
        this.show_all();
        this.has_focus = true;
    },
    
    /** Return a list of phone numbers that the SMS will be sent to */
    send: function (entry, signal_id, event) {
        let contactItems = this.contactEntry.text.split(",").filter((s) => {
            return /\S/.test(s);
        });
        let contactNumbers = [];
        let styleContext = this.contactEntry.get_style_context();
        let model = this.contactEntry.get_completion().get_model();
        
        for (let item of contactItems) {
            item = item.trim();
            let contactNumber = false;
            
            // Search the completion (if present) for an exact contact match
            model.foreach((model, path, iter) => {
                if (item === model.get_value(iter, 1)) {
                    contactNumber = model.get_value(iter, 2);
                    return true;
                }
                
                contactNumber = false;
            });
            
            // Found a matching Contact
            if (contactNumber) {
                contactNumbers.push(contactNumber);
            // No matching Contact, but includes alpha characters
            } else if (/[a-zA-Z]/.test(item)) {
                let start = this.contactEntry.text.indexOf(item);
                let end = start + item.length;
                
                this.contactEntry.has_focus = true;
                this.contactEntry.secondary_icon_name = "dialog-error-symbolic";
                this.contactEntry.select_region(start, end);
                
                if (!styleContext.has_class("error")) {
                    styleContext.add_class("error");
                }
                
                return false;
            // Anything else can be handled by the device (libphonenumber)
            } else {
                contactNumbers.push(item);
            }
        }
        
        if (!contactNumbers.length) {
            this.contactEntry.has_focus = true;
            this.contactEntry.secondary_icon_name = "dialog-error-symbolic";
            
            if (!styleContext.has_class("error")) {
                styleContext.add_class("error");
            }
            
            return false;
        }
        
        // Send to each contactNumber
        for (let number of contactNumbers) {
            this.device.sms(number, entry.text);
        }
        
        // Log the sent message in the Conversation View and clear the entry
        let message = "<b>" + this.user_name + ":</b> " + entry.text + "\n";
        this.conversationBuffer.insert_markup(
            this.conversationBuffer.get_end_iter(),
            message,
            message.length
        );
        entry.text = "";
    }
});

const Application = new Lang.Class({
    Name: "Application",
    Extends: Gtk.Application,

    _init: function() {
        this.parent({
            application_id: "org.gnome.shell.extensions.mconnect.sms",
            flags: Gio.ApplicationFlags.FLAGS_NONE,
            register_session: true
        });
        
        let application_name = _("MConnect SMS");

        GLib.set_prgname(application_name);
        GLib.set_application_name(application_name);
        
        this._id = null;
        
        // Options
        this.add_main_option(
            "device",
            "d".charCodeAt(0),
            GLib.OptionFlags.NONE,
            GLib.OptionArg.STRING,
            "Device ID",
            "<device-id>"
        );
    },

    vfunc_startup: function() {
        this.parent();
        
        Gtk.IconTheme.get_default().add_resource_path("/icons");
        
        if (Settings.get_enum("service-provider") === ServiceProvider.MCONNECT) {
            this.manager = new MConnect.DeviceManager();
        } else {
            this.manager = new KDEConnect.DeviceManager();
        }
    },

    vfunc_activate: function() {
        let device;
        
        for (let dbusPath in this.manager.devices) {
            let dev = this.manager.devices[dbusPath];
            
            if (dev.id === this._id && dev.hasOwnProperty("telephony")) {
                device = dev;
            }
        }
        
        if (device === undefined) {
            throw Error("Device is unreachable or doesn't support sending SMS");
        }
        
        let windows = this.get_windows();
        let window = false;
        
        for (let index_ in windows) {
            if (device.id === windows[index_].device.id) {
                window = windows[index_];
            }
        }
        
        if (!window) { window = new ApplicationWindow(this, device); }
        
        window.present();
    },
    
    vfunc_handle_local_options: function(options) {
        if (options.contains("device")) {
            this._id = options.lookup_value("device", null).deep_unpack();
            return -1;
        }
        
        throw Error("Device ID not specified");
        return 1;
    },

    vfunc_shutdown: function() {
        this.parent();
        
        this.manager.destroy();
        delete this.manager;
    }
});

(new Application()).run([System.programInvocationName].concat(ARGV));

