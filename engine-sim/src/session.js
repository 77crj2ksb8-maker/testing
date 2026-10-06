// Session records for the telemetry panel: peaks, 0–100 km/h, distance and a
// short rolling history for the live trace. Pure JS.

export class SessionStats {
  constructor() {
    this.reset();
  }

  reset() {
    this.peakRpm = 0;
    this.topSpeedKmh = 0;
    this.distanceM = 0;
    this.bestZeroToHundred = null;
    this.lastZeroToHundred = null;
    this.runStart = null; // sim time when the car last pulled away from rest
    this.startDistance = null;
    this.history = []; // [{ t, rpm, kmh, torque }]
    this.sampleClock = 0;
  }

  update(dt, sim) {
    const kmh = sim.speedKmh;
    if (sim.rpm > this.peakRpm) this.peakRpm = sim.rpm;
    if (kmh > this.topSpeedKmh) this.topSpeedKmh = kmh;
    if (this.startDistance === null) this.startDistance = sim.distance;
    this.distanceM = sim.distance - this.startDistance;

    // 0–100 km/h: the clock starts when a stationary car begins to move forward.
    if (kmh < 0.5) this.runStart = null;
    else if (this.runStart === null && sim.v > 0 && kmh < 3) this.runStart = sim.time - dt;
    if (this.runStart !== null && kmh >= 100) {
      const t = sim.time - this.runStart;
      this.lastZeroToHundred = t;
      if (this.bestZeroToHundred === null || t < this.bestZeroToHundred) this.bestZeroToHundred = t;
      this.runStart = null;
    }

    this.sampleClock += dt;
    if (this.sampleClock >= 0.05) {
      this.sampleClock = 0;
      this.history.push({ t: sim.time, rpm: sim.rpm, kmh, torque: sim.combustionTorque });
      if (this.history.length > 200) this.history.shift();
    }
  }
}
