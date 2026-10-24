/*
 * Frida hook — dump the Muse dictation access token / handshake from a running app.
 *
 * Why: the Voyager handshake carries `authorization.accessToken`, a Meta user
 * session token that is not shipped inside the APK. Everything else about the
 * protocol is implemented in src/protocol.mjs.
 *
 * Usage (device needs a frida-server, or use a debuggable build):
 *   frida -U -f com.facebook.aura -l tools/frida-dump-token.js --no-pause
 *   # then hold the mic button in the app, the token prints to the console
 *
 * Two hooks, so you can cross-check:
 *   1. X.BDO.A0Z(UserSession)  -> returns the raw access token
 *   2. VoyagerAsrSocket.send(String) -> the full handshake JSON, token included
 *
 * Class names are from Muse 13.0.0.4.159 and are obfuscated; re-verify them if
 * Frida reports "class not found" on a newer version.
 */

Java.perform(function () {
  const TAG = "[asr-transcribe-server]";

  // 1) token getter
  try {
    const BDO = Java.use("X.BDO");
    BDO.A0Z.implementation = function (session) {
      const token = this.A0Z(session);
      console.log(TAG + " BDO.A0Z -> " + token);
      return token;
    };
    console.log(TAG + " hooked X.BDO.A0Z");
  } catch (e) {
    console.log(TAG + " skip X.BDO.A0Z: " + e.message);
  }

  // 2) the socket itself: text frame = handshake / endStream, byte[] = audio
  try {
    const Socket = Java.use("com.facebook.aura.composer.dictation.voyager.VoyagerAsrSocket");
    // it is an interface; hook the concrete impl instead
    const Impl = Java.use("com.facebook.aura.composer.dictation.voyager.VoyagerSocket");
    Impl.send.overload("java.lang.String").implementation = function (text) {
      if (text.indexOf("accessToken") !== -1) {
        console.log(TAG + " handshake: " + text);
      } else {
        console.log(TAG + " text frame: " + text);
      }
      return this.send(text);
    };
    Impl.send.overload("[B").implementation = function (bytes) {
      // do not log every 20 ms frame, just the size once in a while
      this.__logged = (this.__logged || 0) + 1;
      if (this.__logged % 50 === 1) console.log(TAG + " audio frame " + bytes.length + " bytes");
      return this.send(bytes);
    };
    console.log(TAG + " hooked VoyagerSocket.send");
  } catch (e) {
    console.log(TAG + " skip VoyagerSocket: " + e.message);
  }
});
