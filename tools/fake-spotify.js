import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
const START = Number(ARGV[0] ?? 55) * 1e6;
const IFACE = `<node>
<interface name="org.mpris.MediaPlayer2.Player">
<method name="Next"/><method name="Previous"/><method name="PlayPause"/><method name="Play"/><method name="Pause"/>
<method name="SetPosition"><arg direction="in" type="o"/><arg direction="in" type="x"/></method>
<property name="PlaybackStatus" type="s" access="read"/><property name="Metadata" type="a{sv}" access="read"/>
<property name="Position" type="x" access="read"/><property name="CanGoNext" type="b" access="read"/><property name="CanGoPrevious" type="b" access="read"/>
<property name="CanPlay" type="b" access="read"/><property name="CanPause" type="b" access="read"/><property name="CanSeek" type="b" access="read"/><property name="CanControl" type="b" access="read"/>
<signal name="Seeked"><arg type="x"/></signal></interface></node>`;
const tracks = [
 {id:'0VjIjW4GlUZAMYd2vXMi3b', title:'Blinding Lights', artist:['The Weeknd'], album:'After Hours', len:200040000},
 {id:'7qiZfU4dY1lWllzX7mPBI3', title:'Shape of You', artist:['Ed Sheeran'], album:'÷ (Deluxe)', len:233713000},
];
let ti = 0, playing = true, base = START, t0 = GLib.get_monotonic_time();
const pos = () => playing ? base + (GLib.get_monotonic_time() - t0) : base;
const md = () => { const t = tracks[ti]; return {
 'mpris:trackid': new GLib.Variant('o', `/com/spotify/track/${t.id}`),
 'mpris:length': new GLib.Variant('x', t.len), 'xesam:title': new GLib.Variant('s', t.title),
 'xesam:artist': new GLib.Variant('as', t.artist), 'xesam:album': new GLib.Variant('s', t.album),
 'mpris:artUrl': new GLib.Variant('s', 'file://' + ARGV[1]), 'xesam:url': new GLib.Variant('s', `https://open.spotify.com/track/${t.id}`)}; };
const impl = {
 get Identity(){return 'Spotify'}, get DesktopEntry(){return 'spotify'}, CanQuit:false, CanRaise:false, HasTrackList:false, SupportedUriSchemes:[], SupportedMimeTypes:[],
 get PlaybackStatus(){return playing?'Playing':'Paused'}, get Metadata(){return md()}, get Position(){return pos()},
 CanGoNext:true, CanGoPrevious:true, CanPlay:true, CanPause:true, CanSeek:true, CanControl:true,
 PlayPause(){ base = pos(); t0 = GLib.get_monotonic_time(); playing = !playing; obj.emit_property_changed('PlaybackStatus', new GLib.Variant('s', impl.PlaybackStatus)); },
 Play(){ if(!playing) impl.PlayPause(); }, Pause(){ if(playing) impl.PlayPause(); },
 Next(){ ti=(ti+1)%tracks.length; base=0; t0=GLib.get_monotonic_time(); obj.emit_property_changed('Metadata', new GLib.Variant('a{sv}', md())); },
 Previous(){ impl.Next(); },
 SetPosition(id, p){ base=p; t0=GLib.get_monotonic_time(); obj.emit_signal('Seeked', new GLib.Variant('(x)', [p])); },
};
const obj = Gio.DBusExportedObject.wrapJSObject(IFACE, impl);
obj.export(Gio.DBus.session, '/org/mpris/MediaPlayer2');
Gio.bus_own_name_on_connection(Gio.DBus.session, 'org.mpris.MediaPlayer2.spotify', 0, null, null);
// control file: write "pause", "next", "seek N"
GLib.timeout_add(0, 200, () => { try { const [ok, c] = GLib.file_get_contents(ARGV[2]); const cmd = new TextDecoder().decode(c).trim(); if (cmd) { GLib.file_set_contents(ARGV[2], ''); const [a,b]=cmd.split(' '); if(a==='pause') impl.PlayPause(); if(a==='next') impl.Next(); if(a==='seek') impl.SetPosition('', Number(b)*1e6);} } catch {} return true; });
new GLib.MainLoop(null, false).run();
