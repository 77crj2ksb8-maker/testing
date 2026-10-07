// Audio feature module: routes simulator and gearbox events from the bus to the
// engine sound (src/audio.js). The continuous voice reads the simulator every
// frame in audio.update(); everything event-shaped arrives here.

export default {
  id: 'audiofx',
  install(app) {
    const { bus, audio } = app;
    bus.on('backfire', (e) => audio.backfire(e));
    bus.on('twostep', () => audio.twoStep());
    bus.on('shift', (e) => audio.shift(e));
    bus.on('bov', (e) => audio.blowOff(e));
    bus.on('vvl', (e) => audio.setVvl(e.on));
    bus.on('overrev', (e) => audio.overrev(e));
    bus.on('stall', () => audio.stall());
    bus.on('blown', () => audio.blowUp());
    bus.on('repair', () => audio.repair());
    // main.js only re-voices the engine when the profile id changes; displacement,
    // redline or a new layout with the same id still need fresh tables and pipe length.
    bus.on('profile', ({ profile }) => {
      if (profile && profile !== audio.profile) audio.setProfile(profile);
    });
    return {};
  },
};
