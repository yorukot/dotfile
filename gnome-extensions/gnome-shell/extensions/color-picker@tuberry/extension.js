// SPDX-FileCopyrightText: tuberry
// SPDX-License-Identifier: GPL-3.0-or-later

import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Cairo from 'gi://cairo';
import Shell from 'gi://Shell';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Slider from 'resource:///org/gnome/shell/ui/slider.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

import {Color} from './color.js';
import {Field, Format, Preset} from './const.js';
import {encode, hook, array, pickle} from './util.js';
import {IconButton, MenuItem, RadioItem, IconItem, Systray} from './menu.js';
import {Setting, Extension, Mortal, Source, hub, view, _, myself, copy} from './fubar.js';

const Notify = {MSG: 0, OSD: 1};
const Preview = {LENS: 0, LABEL: 1};
const Sound = {SCREENSHOT: 0, COMPLETE: 1};
const CP_IFACE = `<node>
    <interface name="org.gnome.Shell.Extensions.ColorPicker">
        <method name="Pick">
            <arg type="a{sv}" direction="out" name="result"/>
        </method>
    </interface>
</node>`; // same result as XDP Screenshot

const genColorSwatch = color => encode(`<svg width="64" height="64" fill="${color}" viewBox="0 0 1 1">
    <rect width=".75" height=".75" x=".125" y=".125" rx=".15"/>
</svg>`);

class ColorItem extends MenuItem {
    static {
        GObject.registerClass(this);
    }

    constructor(callback, color) {
        super('', () => copy(this.$color.toText()), {can_focus: false});
        this.label.set({x_expand: true, can_focus: true});
        this.label.add_style_class_name('color-picker-item-label');
        this.$btn = new IconButton({style_class: 'color-picker-icon'}, () => callback(this.$color.toRaw()));
        this.add_child(this.$btn);
        this.setColor(color);
    }

    setColor(color) {
        if(!color) return;
        let [icon, raw, fmts] = color;
        this.$btn.setIcon(icon ? 'starred-symbolic' : 'non-starred-symbolic');
        this.$color = new Color(raw, fmts);
        this.label.clutter_text.set_markup(this.$color.toMarkup());
    }
}

class ColorSection extends PopupMenu.PopupMenuSection {
    constructor(colors, callback) {
        super();
        this.setColors(colors, callback);
    }

    setColors(colors, callback) {
        let items = this._getMenuItems();
        let diff = colors.length - items.length;
        if(diff > 0) for(let a = 0; a < diff; a++) this.addMenuItem(new ColorItem(callback));
        else if(diff < 0) for(let a = 0; a > diff; a--) items.at(a - 1).destroy();
        this._getMenuItems().forEach((x, i) => x.setColor(colors[i]));
    }
}

class ColorSlider extends Slider.Slider {
    static {
        GObject.registerClass(this);
    }

    constructor(type, value, step, color, callback) {
        super(value);
        this.$data = {type, step, color};
        this.connect('notify::value', () => callback(type, this.value));
    }

    vfunc_repaint() {
        let cr = this.get_context(),
            {color, type} = this.$data,
            [width, height] = this.get_surface_size(),
            gradient = new Cairo.LinearGradient(0, 0, width, 0),
            barLevelRadius = Math.min(width, this._barLevelHeight) / 2,
            rtl = this.get_text_direction() === Clutter.TextDirection.RTL;
        cr.arc(barLevelRadius, height / 2, barLevelRadius, Math.PI * (1 / 2), Math.PI * (3 / 2));
        cr.arc(width - barLevelRadius, height / 2, barLevelRadius, Math.PI * 3 / 2, Math.PI / 2);
        color.toStops(type, rtl).forEach(x => gradient.addColorStopRGBA(...x));
        cr.setSource(gradient);
        cr.fill();

        let ceiledHandleRadius = Math.ceil(this._handleRadius + this._handleBorderWidth),
            handleX = ceiledHandleRadius + (width - 2 * ceiledHandleRadius) * this._value / this._maxValue,
            handleY = height / 2;
        if(rtl) handleX = width - handleX;
        cr.setSourceRGB(...color.rgb);
        cr.arc(handleX, handleY, this._handleRadius, 0, 2 * Math.PI);
        if(this._handleBorderColor && this._handleBorderWidth) {
            cr.fillPreserve();
            cr.setSourceColor(this._handleBorderColor);
            cr.setLineWidth(this._handleBorderWidth);
            cr.stroke();
        } else {
            cr.fill();
        }
        cr.setSourceColor(this.get_theme_node().get_foreground_color());
        cr.arc(handleX, handleY, barLevelRadius, 0, 2 * Math.PI);
        cr.fill();
        cr.$dispose();
    }

    $updateValue(delta) {
        this.value = Math.clamp(this._value + delta, 0, this._maxValue);
    }

    vfunc_key_press_event(event) {
        switch(event.get_key_symbol()) {
        case Clutter.KEY_Left: this.$updateValue(-this.$data.step); break;
        case Clutter.KEY_Right: this.$updateValue(this.$data.step); break;
        default: return super.vfunc_key_press_event(event);
        }
        return Clutter.EVENT_STOP;
    }

    scroll(event) {
        if(event.is_pointer_emulated()) return Clutter.EVENT_PROPAGATE;
        switch(event.get_scroll_direction()) {
        case Clutter.ScrollDirection.UP: this.$updateValue(this.$data.step); break;
        case Clutter.ScrollDirection.DOWN: this.$updateValue(-this.$data.step); break;
        case Clutter.ScrollDirection.SMOOTH: this.$updateValue(-event.get_scroll_delta().at(1) * this.$data.step); break;
        }
        return Clutter.EVENT_STOP;
    }
}

class SliderItem extends PopupMenu.PopupBaseMenuItem {
    static {
        GObject.registerClass(this);
    }

    constructor(type, value, step, color, callback) {
        super({activate: false});
        let slider = new ColorSlider(type, value, step, color, callback);
        let label = new St.Label({text: type.toUpperCase(), x_expand: false});
        this.connect('key-press-event', (_a, event) => slider.vfunc_key_press_event(event));
        this.setValue = v => { slider._value = v; slider.queue_repaint(); };
        [label, slider].forEach(x => this.add_child(x));
    }
}

class ColorMenu extends PopupMenu.PopupMenu {
    constructor(source, color) {
        super(source ?? Main.layoutManager.dummyCursor, 0.15, St.Side.LEFT);
        this.$color = color;
        this.$formats = array(color.formats.length).slice(Preset.length);
        this.$manager = new PopupMenu.PopupMenuManager(source);
        this.$manager.addMenu(this);
        this.actor.add_style_class_name('color-picker-menu');
        Main.layoutManager.addTopChrome(this.actor);
        this.actor.hide();
        this.$addMenuItems();
    }

    $addMenuItems() {
        let {r, g, b, h, s, l} = this.$color.toRGBHSL();
        this.$menu = {
            HEX: this.$genHEXItem(),
            RGB: new PopupMenu.PopupSeparatorMenuItem(),
            r: this.$genSliderItem({r}, 1 / 255),
            g: this.$genSliderItem({g}, 1 / 255),
            b: this.$genSliderItem({b}, 1 / 255),
            HSL: new PopupMenu.PopupSeparatorMenuItem(),
            h: this.$genSliderItem({h}, 1 / 360),
            s: this.$genSliderItem({s}, 1 / 100),
            l: this.$genSliderItem({l}, 1 / 100),
            custom: this.$genCustomSection(),
        };
        Object.values(this.$menu).forEach(x => this.addMenuItem(x));
    }

    $genSliderItem(initial, step) {
        let [[type, value]] = Object.entries(initial);
        return new SliderItem(type, value, step, this.$color, this.$updateSlider.bind(this));
    }

    $updateSlider(type, value) {
        this.$color.update(type, value);
        Object.entries(this.$color.toRGBHSL()).forEach(([k, v]) => k === type || this.$menu[k].setValue(v));
        this.$updateLabels();
    }

    $genCustomSection() {
        let section = new PopupMenu.PopupMenuSection();
        let items = this.$formats.map(x => new MenuItem('', () => this.$emitSelected(x)));
        if(items.length) section.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(_('Others')));
        items.forEach(x => section.addMenuItem(x));
        section.updateLabels = () => items.forEach((x, i) => x.label.set_text(this.$color.toText(this.$formats[i])));
        return section;
    }

    $updateLabels() {
        ['RGB', 'HSL'].forEach(x => this.$menu[x].label.set_text(this.$color.toText(Format[x])));
        this.$menu.HEX.label.clutter_text.set_markup(this.$color.toMarkup(Format.HEX));
        this.$menu.custom.updateLabels();
    }

    $genHEXItem() {
        let item = new MenuItem('', () => this.emit('color-selected', this.$color), {can_focus: false});
        item.label.add_style_class_name('color-picker-item-label');
        item.label.set_can_focus(true);
        ['RGB', 'HSL', 'HEX'].forEach((x, i) => item.insert_child_at_index(hook({
            clicked: () => { this.close(); this.$emitSelected(Format[x]); },
        }, new St.Button({can_focus: true, label: x, style_class: 'color-picker-button button'})), i));
        return item;
    }

    summon(coords) {
        this.$updateSlider();
        if(this.sourceActor === Main.layoutManager.dummyCursor) Main.layoutManager.setDummyCursorGeometry(...coords, 12, 12);
        this.open(BoxPointer.PopupAnimation.FULL);
    }

    $emitSelected(format) {
        this.$color.format = format;
        this.emit('color-selected', this.$color);
    }
}

class ColorLens extends St.DrawingArea {
    static {
        GObject.registerClass(this);
    }

    constructor(param) {
        super({style_class: 'color-picker-lens', ...param});
        this.$data = {x: 0, y: 0, color: new Color(), pixels: [], area: [0, 0, 0, 0, 0]};
        this.$zoom = 8 * St.ThemeContext.get_for_stage(global.stage).scaleFactor; // grid length
        this.$unit = 1 / this.$zoom;
    }

    setData(data) {
        this.$data = data;
        let s = this.$zoom;
        let {x, y, area: [w, h, c_x, c_y]} = data;
        this.set_size((w + 2) * s, (h + 2) * s);
        this.set_position(x - (c_x + 1) * s, y - (c_y + 1) * s);
        this.queue_repaint();
    }

    vfunc_repaint() {
        let cr = this.get_context(),
            {color, pixels, area: [w, h, c_x, c_y, r]} = this.$data,
            s = this.$zoom;
        cr.scale(s, s);
        cr.translate(1, 1);
        this.$clipRing(cr, color, c_x, c_y, r);
        this.$fillGrid(cr, pixels, w, h, c_x, c_y, r + 1);
        this.$lineGrid(cr, Math.max(w, h));
        this.$showPixel(cr, color, c_x, c_y);
        cr.$dispose();
    }

    $clipRing(cr, color, c_x, c_y, r) {
        cr.save();
        cr.setLineWidth(1);
        cr.setSourceRGB(...color.rgb);
        cr.arc(c_x + 1 / 2, c_y + 1 / 2, r + 1 / 2, 0, Math.PI * 2);
        cr.strokePreserve();
        cr.setLineWidth(1 / 2);
        cr.setSourceRGBA(1, 1, 1, 0.4);
        cr.strokePreserve();
        cr.restore();
        cr.clip();
    }

    $fillGrid(cr, pixels, w, h, c_x, c_y, r) {
        for(let i = 0; i < w; i++) {
            for(let j = 0; j < h; j++) {
                if(Math.hypot(i - c_x, j - c_y) > r) continue;
                let [red, g, b] = pixels.slice((j * w + i) * 4, -1);
                cr.setSourceRGBA(red / 255, g / 255, b / 255, 1);
                cr.rectangle(i, j, 1, 1);
                cr.fill();
            }
        }
    }

    $lineGrid(cr, l) {
        cr.setLineWidth(this.$unit);
        cr.setSourceRGBA(0, 0, 0, 0.4);
        for(let i = 0; i <= l; i++) {
            cr.moveTo(i, 0);
            cr.lineTo(i, l);
            cr.moveTo(0, i);
            cr.lineTo(l, i);
        }
        cr.stroke();
    }

    $showPixel(cr, color, c_x, c_y) {
        cr.setLineWidth(this.$unit * 2);
        cr.setSourceRGB(...color.toComplement());
        cr.rectangle(c_x, c_y, 1, 1);
        cr.stroke();
    }
}

class ColorViewer extends BoxPointer.BoxPointer {
    static {
        GObject.registerClass(this);
    }

    constructor(plain) {
        super(St.Side.TOP);
        Main.layoutManager.addTopChrome(this);
        this.set({visible: false, style_class: 'color-picker-boxpointer'});
        this.bin.set_child(new St.Label({style_class: 'color-picker-label'}));
        this.$src = Source.fuse({lens: this.$genLens(plain)}, this);
    }

    $genLens(plain) {
        let lens;
        if(plain) {
            lens = new Clutter.Actor({opacity: 0, width: 12, height: 12});
            lens.setData = ({x, y}) => lens.set_position(x, y);
            this.$pos = 0;
        } else {
            lens = new ColorLens({width: 1, height: 1});
            this.$pos = 1 / 2;
        }
        Main.layoutManager.addTopChrome(lens);
        return lens;
    }

    setContent(data) {
        this.bin.child.clutter_text.set_markup(data.color.toPreview());
        this.setPosition(this.$src.lens, this.$pos);
        this.$src.lens.setData(data);
        this.open(BoxPointer.PopupAnimation.NONE);
    }
}

class ColorArea extends St.Widget {
    static {
        GObject.registerClass({
            Signals: {
                'end-pick': {param_types: [GObject.TYPE_BOOLEAN]},
                'notify-color': {param_types: [GObject.TYPE_JSOBJECT]},
            },
        }, this);
    }

    constructor(set, once, format, formats) {
        super({reactive: true, style_class: 'screenshot-ui-screen-screenshot'});
        Main.layoutManager.addTopChrome(this);
        Main.pushModal(this, {actionMode: Shell.ActionMode.POPUP});
        Main.uiGroup.set_child_above_sibling(Main.messageTray, this); // NOTE: show notifications in persistent mode
        this.add_constraint(new Clutter.BindConstraint({source: global.stage, coordinate: Clutter.BindCoordinate.ALL}));

        this.$once = once;
        this.$color = Color.new_for_format(format, formats);
        this.$buildWidgets();
        this.$bindSettings(set);
        this.$initContents();
    }

    $buildWidgets() {
        let setCursor = x => global.display.set_cursor(x);
        let onMenuToggle = (_w, open) => this.$src.cursor.toggle(!open); // HACK: workaround for tsserver autocomplete inability
        this.$src = Source.fuse({
            format: new Source(x => hook({
                'open-state-changed': onMenuToggle,
                'color-selected': (_a, color) => this.$emitColor(color),
            }, new ColorMenu(x, this.$color))),
            cursor: new Source((x = this.cursor) => x && setCursor(x), () => setCursor(Meta.Cursor.DEFAULT)),
            viewer: new Source(x => new ColorViewer(x)),
        }, this);
        this.$ptr = Clutter.get_default_backend().get_default_seat().create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
        this.openMenu = () => this.$src.format.hub?.summon(this.$coords);
        this.connect('popup-menu', () => this.openMenu());
    }

    $bindSettings(set) {
        this.$set = set.attach({
            menukey: [Field.MKEY, 'string'],
            quitkey: [Field.QKEY, 'string'],
            persist: [Field.PRST, 'boolean', x => { this.$once ||= !x; }],
        }, this).attach({
            menuset: [Field.MENU, 'boolean'],
            preview: [Field.PVWS, 'uint',    x => x === Preview.LABEL, x => this.$src.viewer.reload(x)],
            viewing: [Field.PVW,  'boolean', x => this.$src.viewer.toggle(x, this.preview)],
        }, this, () => this.$onViewerPut(), true);
    }

    async $initContents() {
        let [content, scale] = await new Shell.Screenshot().screenshot_stage_to_content();
        this.set_content(content);
        let texture = content.get_texture();
        this.$data = {scale, texture, width: texture.get_width() - 1, height: texture.get_height() - 1};
        this.pickColor = this.$pickColor; // HACK: workaround for unexpected motion events when using shortcut on Xorg
        if(this.$coords) this.pickColor(this.$coords);
    }

    get viewer() {
        return this.$src.viewer?.hub;
    }

    get cursor() {
        return !this.viewing || this.preview ? Meta.Cursor.CROSSHAIR : Meta.Cursor.BLANK;
    }

    $onViewerPut() {
        this.$src.cursor.summon();
        this.$src.format.reboot(this.menuset, this.$src.viewer.hub);
        if(this.$coords) this.pickColor(this.$coords);
    }

    pickColor(coords) {
        this.$coords = coords;
    }

    async $pickColor(coords) {
        this.$coords = coords;
        try {
            let [x, y] = coords.map(Math.round),
                {scale, width, height, texture} = this.$data,
                stream = Gio.MemoryOutputStream.new_resizable(),
                [a, b, w, h, c_x, c_y, r] = this.$getLoupe(x, y, scale, width, height),
                pixbuf = await Shell.Screenshot.composite_to_stream(texture, a, b, w, h, scale, null, 0, 0, 1, stream),
                pixels = pixbuf.get_pixels();
            stream.close(null);
            this.$color.fromPixels(pixels, (c_y * w + c_x) * 4);
            this.viewer?.setContent({x, y, color: this.$color, pixels, area: [w, h, c_x, c_y, r]});
        } catch(e) {
            this.emit('end-pick', true);
        }
    }

    $getLoupe(x, y, scale, width, height) {
        x = Math.clamp(Math.round(x * scale), 0, width);
        y = Math.clamp(Math.round(y * scale), 0, height);
        if(this.preview) return [x, y, 1, 1, 0, 0, 0];
        let r = 10,
            a = Math.max(x - r, 0),
            b = Math.max(y - r, 0),
            w = Math.min(x, width - x, r) + r + 1,
            h = Math.min(y, height - y, r) + r + 1;
        return [a, b, w, h, x - a, y - b, r];
    }

    $emitColor(color) {
        this.emit('notify-color', color || this.$color);
        if(this.$once) this.emit('end-pick', false);
    }

    vfunc_motion_event(event) {
        this.pickColor(event.get_coords());
        return Clutter.EVENT_PROPAGATE;
    }

    vfunc_enter_event(event) {
        this.pickColor(event.get_coords());
        return super.vfunc_enter_event(event);
    }

    $movePointerBy(dx, dy) {
        this.$ptr.notify_relative_motion(global.get_current_time(), dx, dy);
    }

    vfunc_key_press_event(event) {
        switch(event.get_key_symbol()) {
        case Clutter.KEY_Escape:
        case Clutter[`KEY_${this.quitkey}`]: this.emit('end-pick', true); break;
        case Clutter[`KEY_${this.menukey}`]: this.openMenu(); break;
        case Clutter.KEY_a:
        case Clutter.KEY_h:
        case Clutter.KEY_Left: this.$movePointerBy(-1, 0); break;
        case Clutter.KEY_w:
        case Clutter.KEY_k:
        case Clutter.KEY_Up: this.$movePointerBy(0, -1); break;
        case Clutter.KEY_d:
        case Clutter.KEY_l:
        case Clutter.KEY_Right: this.$movePointerBy(1, 0); break;
        case Clutter.KEY_s:
        case Clutter.KEY_j:
        case Clutter.KEY_Down: this.$movePointerBy(0, 1); break;
        case Clutter.KEY_space:
        case Clutter.KEY_Return:
        case Clutter.KEY_KP_Enter:
        case Clutter.KEY_ISO_Enter: this.$emitColor(); break;
        case Clutter.KEY_Control_L: this.$set.set('preview', this.preview ? Preview.LENS : Preview.LABEL, this); break;
        default: return super.vfunc_key_press_event(event);
        }
        return Clutter.EVENT_PROPAGATE;
    }

    vfunc_scroll_event(event) {
        switch(event.get_scroll_direction()) {
        case Clutter.ScrollDirection.UP: if(this.preview) this.$set.set('preview', Preview.LENS, this); break;
        case Clutter.ScrollDirection.DOWN: if(!this.preview) this.$set.set('preview', Preview.LABEL, this); break;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    vfunc_button_press_event(event) {
        switch(event.get_button()) {
        case Clutter.BUTTON_PRIMARY: this.$emitColor(); break;
        case Clutter.BUTTON_MIDDLE: this.openMenu(); break;
        default: this.emit('end-pick', true); break;
        }
        return Clutter.EVENT_PROPAGATE;
    }
}

class ColorButton extends Systray {
    static {
        GObject.registerClass(this);
    }

    constructor(set, callback, menu) {
        super(menu);
        this.$bindSettings(set);
        this.$buildWidgets(callback);
    }

    $buildWidgets(callback) {
        this.$callback = callback;
        this.menu.actor.add_style_class_name('color-picker-menu');
        this.add_style_class_name('color-picker-systray');
        let param = {style_class: 'color-picker-icon'};
        let items = {
            sep0:   new PopupMenu.PopupSeparatorMenuItem(),
            colors: new ColorSection(...this.$getColors()),
            sep1:   new PopupMenu.PopupSeparatorMenuItem(),
            prefs:  new IconItem({
                pick: [param, () => { this.menu.close(); this.$callback(); }, 'find-location-symbolic'],
                star: [param, () => this.$set.set('menu_style', !this.menu_style, this), [this.menu_style, 'semi-starred-symbolic', 'starred-symbolic']],
                gear: [param, () => { this.menu.close(); myself().openPreferences(); }, 'emblem-system-symbolic'],
            }),
        };
        Object.assign(this.$menu, items);
        Object.values(items).forEach(x => this.menu.addMenuItem(x));
    }

    $bindSettings(set) {
        this.$set = set.attach({
            menu_size:  [Field.MSIZ, 'uint'],
            icon_name:  [Field.TICN, 'string',  x => this.$icon.set_icon_name(x || 'color-select-symbolic')],
        }, this).attach({
            collect:    [Field.CLCT, 'value', x => x.deepUnpack()],
            history:    [Field.HIST, 'value', x => x.deepUnpack()],
            menu_style: [Field.MSTL, 'boolean'],
        }, this, () => this.$onColorsPut());
    }

    $onColorsPut() {
        this.$menu.colors?.setColors(...this.$getColors());
    }

    $getColors() {
        return [this.menu_style ? this.collect.map(x => [true, x, this.$formats])
            : this.history.map(x => [this.collect.includes(x), x, this.$formats]), x => this.starColor(x)];
    }

    setFormats(formats, options) {
        this.$menu.format.setOptions(options);
        this.$formats = formats;
        this.$onColorsPut();
    }

    starColor(color) {
        let collect = this.collect.includes(color)
            ? this.collect.filter(x => x !== color)
            : [color].concat(this.collect).slice(0, this.menu_size);
        this.$set.set('collect', new GLib.Variant('au', collect), this);
    }

    addHistory(color) {
        let history = [color, ...this.history].slice(0, this.menu_size);
        this.$set.set('history', new GLib.Variant('au', history), this);
    }

    vfunc_event(event) {
        if(event.type() === Clutter.EventType.BUTTON_PRESS && event.get_button() === Clutter.BUTTON_PRIMARY) {
            this.$callback();
            return Clutter.EVENT_STOP;
        }
        return super.vfunc_event(event);
    }
}

class ColorPicker extends Mortal {
    constructor(gset) {
        super();
        this.$buildWidgets(gset);
        this.$bindSettings();
    }

    $buildWidgets(gset) {
        this.$picked = [];
        this.$set = new Setting(null, gset, this);
        this.$src = Source.fuse({
            tray: new Source(() => this.$genSystray()),
            keys: Source.newKeys(this.$set.gset, Field.KEYS, () => this.summon()),
            area: new Source((hooks, ...args) => hook(hooks, new ColorArea(...args))),
            dbus: Source.newDBus(CP_IFACE, '/org/gnome/Shell/Extensions/ColorPicker', this, true),
        }, this);
    }

    $bindSettings() {
        this.$set.attach({
            fmt_hex: [Field.HEX, 'string'],
            fmt_rgb: [Field.RGB, 'string'],
            fmt_hsl: [Field.HSL, 'string'],
            fmt_custom: [Field.CFMT, 'value', x => x.recursiveUnpack().filter(y => y.enable)],
        }, this, () => this.$onFormatsPut(), true).attach({
            fmt_enable:    [Field.FMT,  'boolean', x => view(x, this.$menu?.format)],
            fmt_chosen:    [Field.FMTS, 'uint',    x => this.$menu?.format.setChosen(x)],
            auto_copy:     [Field.COPY, 'boolean'],
            systray:       [Field.STRY, 'boolean', x => this.$src.tray.toggle(x)],
            shortcut:      [Field.KEY,  'boolean', x => this.$src.keys.toggle(x)],
            enable_sound:  [Field.SND,  'boolean'],
            notify_sound:  [Field.SNDS, 'uint', x => x === Sound.COMPLETE ? 'complete' : 'screen-capture'],
            notify_style:  [Field.NTFS, 'uint'],
            enable_notify: [Field.NTF,  'boolean'],
        }, this);
    }

    $onFormatsPut() {
        this.$formats = [this.fmt_hex, this.fmt_rgb, this.fmt_hsl, ...this.fmt_custom.map(x => x.format)];
        this.$src.tray.hub?.setFormats(this.$formats, this.$options);
    }

    get $menu() {
        return this.$src.tray.hub?.$menu;
    }

    get $options() {
        return Preset.concat(this.fmt_custom.map(y => y.name));
    }

    $genSystray() {
        return new ColorButton(this.$set, () => this.summon(), {
            format: new RadioItem(_('Default format'), this.$options, this.fmt_chosen,
                x => this.$set.set('fmt_chosen', x, this), {visible: this.fmt_enable}),
        });
    }

    summon() {
        if(this.$src.area.active) return;
        this.$src.tray.hub?.add_style_pseudo_class('state-busy');
        this.$src.area.summon({'end-pick': () => this.dispel(), 'notify-color': this.inform.bind(this)},
            this.$set, false, this.fmt_enable ? this.fmt_chosen : null, this.$formats);
    }

    dispel() {
        if(!this.$src.area.active) return;
        this.$src.tray.hub?.remove_style_pseudo_class('state-busy');
        if(this.auto_copy && this.$picked.length) copy(this.$picked.splice(0).join(' '));
        this.$src.area.dispel();
    }

    inform(_a, color) {
        let text = color.toText();
        this.$picked.push(text);
        this.$src.tray.hub?.addHistory(color.toRaw());
        if(this.enable_sound) global.display.get_sound_player().play_from_theme(this.notify_sound, _('Color picked'), null);
        if(!this.enable_notify) return;
        let gicon = Gio.BytesIcon.new(genColorSwatch(color.toHEX()));
        if(this.notify_style === Notify.MSG) {
            let source = MessageTray.getSystemSource();
            let message = new MessageTray.Notification({
                gicon, source, isTransient: true,
                title: myself().metadata.name,
                body: _('%s is picked.').format(text),
            });
            source.addNotification(message);
        } else {
            Main.osdWindowManager.show(global.display.get_current_monitor(), gicon, text);
        }
    }

    pickAsync() {
        return new Promise((resolve, reject) => {
            if(this.$src.area.active) reject(Error('busy'));
            this.$src.tray.hub?.add_style_pseudo_class('state-busy');
            this.$src.area.summon({
                'notify-color': (_a, {rgb}) => resolve(rgb),
                'end-pick': (_a, aborted) => { this.dispel(); if(aborted) reject(Error('aborted')); },
            }, this.$set, true);
        });
    }

    async PickAsync(_p, invocation) {
        try {
            invocation.return_value(pickle([{color: await this.pickAsync()}], true, 'd'));
        } catch(e) {
            invocation.return_error_literal(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED, 'Operation was cancelled');
        }
    }
}

export default class MyExtension extends Extension {
    $klass = ColorPicker;
    // API: Main.extensionManager.lookup('color-picker@tuberry').stateObj.pickAsync().then(log).catch(log)
    pickAsync() {
        if(!this[hub]) throw Error('disabled');
        return this[hub].pickAsync();
    }
}
