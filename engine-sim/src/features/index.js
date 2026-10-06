// Feature registry. Each track owns exactly one entry module below, so tracks
// never edit this file. Order is the order hooks run in each frame.
import powertrain from './powertrain.js';
import visuals from './visuals.js';
import audiofx from './audiofx.js';
import hud from './hud.js';
import modes from './modes.js';

export const FEATURES = [powertrain, visuals, audiofx, hud, modes];
