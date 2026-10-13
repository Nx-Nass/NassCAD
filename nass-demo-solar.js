// ============================================================================
// NASSCAD — REAL-DATE SOLAR SYSTEM
//
// Real date → JPL orbital elements → initial state,
// then a local physical simulation:
//
//   • Newton N-body
//   • Velocity Verlet
//   • barycentres (planet + moons orbit their common centre of mass)
//   • J2 Earth / Mars / Jupiter / Saturn
//   • the Moon from Meeus' lunar theory (ELP-2000/82, ch. 47)
//   • 23 gravitating bodies
//   • star field
//   • Saturn's rings
//   • orbit trails
//   • every planet and moon is a real NASSCAD object in objs[]
//
// Planets:
//   Sun Mercury Venus Earth Mars Jupiter Saturn Uranus Neptune
//
// Satellites:
//   Moon
//   Phobos Deimos
//   Io Europa Ganymede Callisto
//   Mimas Enceladus Tethys Dione Rhea Titan Iapetus
//
// NASSCAD 4.7.x — paste directly in ⚡ NassScript
// ============================================================================


// ---------------------------------------------------------------------------
// REMOVE PREVIOUS INSTANCE
// ---------------------------------------------------------------------------

if (
  window.NASS_SOLAR_REAL &&
  typeof window.NASS_SOLAR_REAL.destroy === 'function'
) {
  window.NASS_SOLAR_REAL.destroy(true);
}

await undoPush('Solar System — real-date N-body');

selObj(null, false);


// ---------------------------------------------------------------------------
// CONSTANTS
// ---------------------------------------------------------------------------

const G   = 6.67430e-11;
const AU  = 149597870700;
const DAY = 86400;
const CY  = 36525;

const DEG =
  Math.PI / 180;

const EPS =
  23.43928 * DEG;

const J2000_JD =
  2451545.0;


// ---------------------------------------------------------------------------
// CONFIGURATION
// ---------------------------------------------------------------------------

const CFG = {

  // simulated days / real second
  daysPerSecond: 1.0,

  // 5 minutes.
  // Phobos orbit ≈ 7.65 h → ~92 physics steps/orbit.
  dtSeconds: 300,

  // physics work per animation frame: a hard step cap AND a time budget,
  // so a slow machine lowers the achieved speed instead of freezing
  maxStepsPerFrame: 600,
  frameBudgetMs: 10,

  stars: 3200,

  trails: true,

  trailPointsPlanet: 600,
  trailPointsMoon: 500,

  trailSamplePlanetDays: 0.5,
  trailSampleMoonDays: 0.01,

  // Newtonian oblateness corrections
  useJ2: true,

  // optional solar Schwarzschild 1PN correction
  useGR: false,

  showHUD: true,

  // REAL DATE AT SCRIPT LAUNCH
  defaultDate: new Date(),

  // visual compression only
  planetScale: 42,
  planetCompressionAU: 0.22,

  moonLocalScale: 6.0,
  moonCompressionKm: 150000,
  moonLocalBase: 2.0
};


// ---------------------------------------------------------------------------
// VECTOR MATH
// ---------------------------------------------------------------------------

function V(x=0,y=0,z=0) {
  return [x,y,z];
}

function add(a,b) {
  return [
    a[0]+b[0],
    a[1]+b[1],
    a[2]+b[2]
  ];
}

function sub(a,b) {
  return [
    a[0]-b[0],
    a[1]-b[1],
    a[2]-b[2]
  ];
}

function mul(a,s) {
  return [
    a[0]*s,
    a[1]*s,
    a[2]*s
  ];
}

function dot(a,b) {
  return (
    a[0]*b[0] +
    a[1]*b[1] +
    a[2]*b[2]
  );
}

function cross(a,b) {
  return [
    a[1]*b[2]-a[2]*b[1],
    a[2]*b[0]-a[0]*b[2],
    a[0]*b[1]-a[1]*b[0]
  ];
}

function len(a) {
  return Math.sqrt(dot(a,a));
}

function norm(a) {

  const L =
    len(a) || 1;

  return mul(
    a,
    1/L
  );
}

function mod360(x) {

  x %= 360;

  return (
    x < 0
      ? x+360
      : x
  );
}

function jdFromDate(d) {

  return (
    d.getTime() /
    86400000
    +
    2440587.5
  );
}


// ---------------------------------------------------------------------------
// EQUATORIAL POLE → J2000 ECLIPTIC
// ---------------------------------------------------------------------------

function eqPoleToEcl(
  raDeg,
  decDeg
) {

  const ra =
    raDeg * DEG;

  const dc =
    decDeg * DEG;

  const x =
    Math.cos(dc) *
    Math.cos(ra);

  const y =
    Math.cos(dc) *
    Math.sin(ra);

  const z =
    Math.sin(dc);

  return norm([

    x,

    Math.cos(EPS)*y +
    Math.sin(EPS)*z,

    -Math.sin(EPS)*y +
     Math.cos(EPS)*z

  ]);
}


// ---------------------------------------------------------------------------
// ORBITAL ROTATION
// ---------------------------------------------------------------------------

function rotateOrbital(
  v,
  Omega,
  inc,
  omega
) {

  const co =
    Math.cos(Omega);

  const so =
    Math.sin(Omega);

  const ci =
    Math.cos(inc);

  const si =
    Math.sin(inc);

  const cw =
    Math.cos(omega);

  const sw =
    Math.sin(omega);

  const x=v[0];
  const y=v[1];
  const z=v[2];

  return [

    (
      cw*co -
      sw*so*ci
    )*x +

    (
      -sw*co -
      cw*so*ci
    )*y +

    so*si*z,



    (
      cw*so +
      sw*co*ci
    )*x +

    (
      -sw*so +
      cw*co*ci
    )*y -

    co*si*z,



    sw*si*x +
    cw*si*y +
    ci*z
  ];
}


// ---------------------------------------------------------------------------
// KEPLER
// ---------------------------------------------------------------------------

function solveKepler(
  M,
  e
) {

  M =
    (
      (
        M + Math.PI
      ) %
      (
        2*Math.PI
      )
      +
      2*Math.PI
    )
    %
    (
      2*Math.PI
    )
    -
    Math.PI;

  let E =
    e < 0.8
      ? M
      : Math.PI;

  for (
    let i=0;
    i<14;
    i++
  ) {

    const d =
      (
        E -
        e*Math.sin(E) -
        M
      )
      /
      (
        1 -
        e*Math.cos(E)
      );

    E -= d;

    if (
      Math.abs(d) <
      1e-13
    )
      break;
  }

  return E;
}


// ===========================================================================
// JPL PLANETARY ELEMENTS
//
// Approximate Positions of the Planets.
// Validity of this table: ~1800–2050.
//
// Each pair:
// [value at J2000, rate / Julian century]
// ===========================================================================

const PE = {

  Mercury:{
    a:[0.38709927,0.00000037],
    e:[0.20563593,0.00001906],
    I:[7.00497902,-0.00594749],
    L:[252.25032350,149472.67411175],
    p:[77.45779628,0.16047689],
    N:[48.33076593,-0.12534081]
  },

  Venus:{
    a:[0.72333566,0.00000390],
    e:[0.00677672,-0.00004107],
    I:[3.39467605,-0.00078890],
    L:[181.97909950,58517.81538729],
    p:[131.60246718,0.00268329],
    N:[76.67984255,-0.27769418]
  },

  EMB:{
    a:[1.00000261,0.00000562],
    e:[0.01671123,-0.00004392],
    I:[-0.00001531,-0.01294668],
    L:[100.46457166,35999.37244981],
    p:[102.93768193,0.32327364],
    N:[0,0]
  },

  Mars:{
    a:[1.52371034,0.00001847],
    e:[0.09339410,0.00007882],
    I:[1.84969142,-0.00813131],
    L:[-4.55343205,19140.30268499],
    p:[-23.94362959,0.44441088],
    N:[49.55953891,-0.29257343]
  },

  Jupiter:{
    a:[5.20288700,-0.00011607],
    e:[0.04838624,-0.00013253],
    I:[1.30439695,-0.00183714],
    L:[34.39644051,3034.74612775],
    p:[14.72847983,0.21252668],
    N:[100.47390909,0.20469106]
  },

  Saturn:{
    a:[9.53667594,-0.00125060],
    e:[0.05386179,-0.00050991],
    I:[2.48599187,0.00193609],
    L:[49.95424423,1222.49362201],
    p:[92.59887831,-0.41897216],
    N:[113.66242448,-0.28867794]
  },

  Uranus:{
    a:[19.18916464,-0.00196176],
    e:[0.04725744,-0.00004397],
    I:[0.77263783,-0.00242939],
    L:[313.23810451,428.48202785],
    p:[170.95427630,0.40805281],
    N:[74.01692503,0.04240589]
  },

  Neptune:{
    a:[30.06992276,0.00026291],
    e:[0.00859048,0.00005105],
    I:[1.77004347,0.00035372],
    L:[-55.12002969,218.45945325],
    p:[44.96476227,-0.32241464],
    N:[131.78422574,-0.00508664]
  }
};


// ---------------------------------------------------------------------------
// PLANET POSITION FOR A JULIAN DATE
// ---------------------------------------------------------------------------

function planetPos(
  name,
  jd
) {

  const q =
    PE[name];

  const T =
    (
      jd -
      J2000_JD
    )
    /
    CY;

  const a =
    (
      q.a[0] +
      q.a[1]*T
    )
    *
    AU;

  const e =
    q.e[0] +
    q.e[1]*T;

  const I =
    (
      q.I[0] +
      q.I[1]*T
    )
    *
    DEG;

  const L =
    (
      q.L[0] +
      q.L[1]*T
    )
    *
    DEG;

  const p =
    (
      q.p[0] +
      q.p[1]*T
    )
    *
    DEG;

  const N =
    (
      q.N[0] +
      q.N[1]*T
    )
    *
    DEG;

  const w =
    p-N;

  const M =
    L-p;

  const E =
    solveKepler(
      M,
      e
    );

  const rp = [

    a*(
      Math.cos(E)-e
    ),

    a*
    Math.sqrt(
      1-e*e
    )
    *
    Math.sin(E),

    0
  ];

  return rotateOrbital(
    rp,
    N,
    I,
    w
  );
}


// ---------------------------------------------------------------------------
// PLANET POSITION + VELOCITY
//
// Velocity is obtained by centered numerical derivative of the same
// date-dependent JPL model.
// ---------------------------------------------------------------------------

function planetState(
  name,
  date
) {

  const jd =
    jdFromDate(date);

  const h =
    60/DAY;

  const r =
    planetPos(
      name,
      jd
    );

  const a =
    planetPos(
      name,
      jd-h
    );

  const b =
    planetPos(
      name,
      jd+h
    );

  return {

    r,

    v:
      mul(
        sub(b,a),
        1/120
      )
  };
}


// ===========================================================================
// PHYSICAL DATA
// ===========================================================================

const META = {

  Sun:{
    kind:'sun',
    mass:1.98847e30,
    radiusKm:695700,
    color:0xffb31a,
    rotationHours:609.12,
    tilt:7.25
  },


  Mercury:{
    kind:'planet',
    mass:3.3011e23,
    radiusKm:2439.7,
    color:0x9b9388,
    rotationHours:1407.6,
    tilt:0.034
  },


  Venus:{
    kind:'planet',
    mass:4.8675e24,
    radiusKm:6051.8,
    color:0xd9b36c,
    rotationHours:-5832.5,
    tilt:177.36
  },


  Earth:{
    kind:'planet',
    mass:5.97237e24,
    radiusKm:6371.0084,
    color:0x2878d0,
    rotationHours:23.9344696,
    tilt:23.439,

    j2:1.08262668e-3,
    eqRadiusKm:6378.1363,

    poleRA:0,
    poleDec:90
  },


  Moon:{
    kind:'moon',
    parent:'Earth',

    mass:7.342e22,
    radiusKm:1737.4,

    color:0xbdbdbd,

    rotationHours:655.728,
    tilt:6.68
  },


  Mars:{
    kind:'planet',

    mass:6.4171e23,
    radiusKm:3389.5,

    color:0xb74f35,

    rotationHours:24.6229,
    tilt:25.19,

    j2:1.96045e-3,
    eqRadiusKm:3396.19,

    poleRA:317.68143,
    poleDec:52.8865
  },


  Phobos:{
    kind:'moon',
    parent:'Mars',

    mass:1.0659e16,
    radiusKm:11.2667,

    color:0x8a7868,

    rotationHours:7.65,
    tilt:0
  },


  Deimos:{
    kind:'moon',
    parent:'Mars',

    mass:1.4762e15,
    radiusKm:6.2,

    color:0x9b8b7a,

    rotationHours:30.30,
    tilt:0
  },


  Jupiter:{
    kind:'planet',

    mass:1.89813e27,
    radiusKm:69911,

    color:0xc9a77b,

    rotationHours:9.925,
    tilt:3.13,

    j2:0.01469643,
    eqRadiusKm:71492,

    poleRA:268.056595,
    poleDec:64.495303
  },


  Io:{
    kind:'moon',
    parent:'Jupiter',

    mass:8.931938e22,
    radiusKm:1821.6,

    color:0xe5c05b,

    rotationHours:42.3056,
    tilt:0
  },


  Europa:{
    kind:'moon',
    parent:'Jupiter',

    mass:4.799844e22,
    radiusKm:1560.8,

    color:0xc9b69a,

    rotationHours:84.611,
    tilt:0
  },


  Ganymede:{
    kind:'moon',
    parent:'Jupiter',

    mass:1.4819e23,
    radiusKm:2634.1,

    color:0x9b8c78,

    rotationHours:171.734,
    tilt:0
  },


  Callisto:{
    kind:'moon',
    parent:'Jupiter',

    mass:1.075938e23,
    radiusKm:2410.3,

    color:0x817363,

    rotationHours:400.57,
    tilt:0
  },


  Saturn:{
    kind:'planet',

    mass:5.6834e26,
    radiusKm:58232,

    color:0xd7c58b,

    rotationHours:10.656,
    tilt:26.73,

    j2:0.01629071,
    eqRadiusKm:60268,

    poleRA:40.589,
    poleDec:83.537,

    rings:true
  },


  Mimas:{
    kind:'moon',
    parent:'Saturn',

    mass:3.7493e19,
    radiusKm:198.2,

    color:0xbeb8ac,

    rotationHours:22.618,
    tilt:0
  },


  Enceladus:{
    kind:'moon',
    parent:'Saturn',

    mass:1.08022e20,
    radiusKm:252.1,

    color:0xe4e4df,

    rotationHours:32.885,
    tilt:0
  },


  Tethys:{
    kind:'moon',
    parent:'Saturn',

    mass:6.17449e20,
    radiusKm:531.1,

    color:0xcac8c1,

    rotationHours:45.307,
    tilt:0
  },


  Dione:{
    kind:'moon',
    parent:'Saturn',

    mass:1.095452e21,
    radiusKm:561.4,

    color:0xb8b5ad,

    rotationHours:65.686,
    tilt:0
  },


  Rhea:{
    kind:'moon',
    parent:'Saturn',

    mass:2.306518e21,
    radiusKm:763.5,

    color:0xbdbab3,

    rotationHours:108.42,
    tilt:0
  },


  Titan:{
    kind:'moon',
    parent:'Saturn',

    mass:1.3452e23,
    radiusKm:2574.76,

    color:0xd3a447,

    rotationHours:382.69,
    tilt:0
  },


  Iapetus:{
    kind:'moon',
    parent:'Saturn',

    mass:1.805635e21,
    radiusKm:734.3,

    color:0x8d8172,

    rotationHours:1903.94,
    tilt:0
  },


  Uranus:{
    kind:'planet',

    mass:8.6810e25,
    radiusKm:25362,

    color:0x82cbd4,

    rotationHours:-17.24,
    tilt:97.77
  },


  Neptune:{
    kind:'planet',

    mass:1.02413e26,
    radiusKm:24622,

    color:0x315ca8,

    rotationHours:16.11,
    tilt:28.32
  }
};


// ===========================================================================
// JPL SATELLITE MEAN ELEMENTS — EPOCH J2000
//
// a       km
// e       eccentricity
// w       argument of periapsis deg
// M       mean anomaly at J2000 deg
// i       inclination deg
// N       ascending node deg
// P       orbital period days
// Papsis  apsidal-precession period years
// Pnode   nodal-precession period years
// ===========================================================================

const SAT = {

  // The Moon is not in this table: it is computed from Meeus' lunar
  // theory (moonRelPos, below). Mean elements put it up to ~20° and
  // ~20 000 km away from where it really is on a given date.


  Phobos:{
    frame:'laplace',

    a:9375,
    e:0.015,

    w:216.3,
    M:189.7,

    i:1.1,
    N:169.2,

    P:0.3187,

    Papsis:1.1,
    Pnode:2.3,

    ra:317.7,
    dec:52.9
  },


  Deimos:{
    frame:'laplace',

    a:23457,
    e:0,

    w:0,
    M:205.0,

    i:1.8,
    N:54.3,

    P:1.2625,

    Papsis:0,
    Pnode:56.2,

    ra:316.6,
    dec:53.5
  },


  Io:{
    frame:'laplace',

    a:421800,
    e:0.004,

    w:49.1,
    M:330.9,

    i:0,
    N:0,

    P:1.762732,

    Papsis:1.333,
    Pnode:0,

    ra:268.1,
    dec:64.5
  },


  Europa:{
    frame:'laplace',

    a:671100,
    e:0.009,

    w:45.0,
    M:345.4,

    i:0.5,
    N:184.0,

    P:3.525463,

    Papsis:1.394,
    Pnode:30.202,

    ra:268.1,
    dec:64.5
  },


  Ganymede:{
    frame:'laplace',

    a:1070400,
    e:0.001,

    w:198.3,
    M:324.8,

    i:0.2,
    N:58.5,

    P:7.155588,

    Papsis:68.301,
    Pnode:137.812,

    ra:268.2,
    dec:64.6
  },


  Callisto:{
    frame:'laplace',

    a:1882700,
    e:0.007,

    w:43.8,
    M:87.4,

    i:0.3,
    N:309.1,

    P:16.690440,

    Papsis:277.921,
    Pnode:577.264,

    ra:268.7,
    dec:64.8
  },


  Mimas:{
    frame:'laplace',

    a:186000,
    e:0.020,

    w:160.4,
    M:275.3,

    i:1.6,
    N:66.2,

    P:0.942422,

    Papsis:0.493,
    Pnode:0.986,

    ra:40.6,
    dec:83.5
  },


  Enceladus:{
    frame:'laplace',

    a:238400,
    e:0.005,

    w:119.5,
    M:57.0,

    i:0,
    N:0,

    P:1.370218,

    Papsis:2.916,
    Pnode:0,

    ra:40.6,
    dec:83.5
  },


  Tethys:{
    frame:'laplace',

    a:295000,
    e:0.001,

    w:335.3,
    M:0,

    i:1.1,
    N:273,

    P:1.887802,

    Papsis:0.005,
    Pnode:4.982,

    ra:40.6,
    dec:83.5
  },


  Dione:{
    frame:'laplace',

    a:377700,
    e:0.002,

    w:116,
    M:212,

    i:0,
    N:0,

    P:2.736916,

    Papsis:11.698,
    Pnode:0,

    ra:40.6,
    dec:83.5
  },


  Rhea:{
    frame:'laplace',

    a:527200,
    e:0.001,

    w:44.3,
    M:31.5,

    i:0.3,
    N:133.7,

    P:4.517503,

    Papsis:33.939,
    Pnode:35.775,

    ra:40.6,
    dec:83.5
  },


  Titan:{
    frame:'laplace',

    a:1221900,
    e:0.029,

    w:78.3,
    M:11.7,

    i:0.3,
    N:78.6,

    P:15.945448,

    Papsis:346.680,
    Pnode:687.370,

    ra:36.4,
    dec:84.0
  },


  Iapetus:{
    frame:'laplace',

    a:3561700,
    e:0.028,

    w:254.5,
    M:74.8,

    i:7.6,
    N:86.5,

    P:79.331002,

    Papsis:1662.900,
    Pnode:3130.302,

    ra:288.7,
    dec:78.9
  }
};


// ---------------------------------------------------------------------------
// LAPLACE-PLANE BASIS
// ---------------------------------------------------------------------------

function laplaceBasis(
  ra,
  dec
) {

  const k =
    eqPoleToEcl(
      ra,
      dec
    );

  const ez =
    [0,0,1];

  let ex =
    cross(
      ez,
      k
    );

  if (
    len(ex) <
    1e-8
  ) {

    ex =
      [1,0,0];

  } else {

    ex =
      norm(ex);
  }

  const ey =
    norm(
      cross(
        k,
        ex
      )
    );

  return {
    ex,
    ey,
    ez:k
  };
}


// ---------------------------------------------------------------------------
// SATELLITE RELATIVE POSITION FOR DATE
// ---------------------------------------------------------------------------

function satRelPos(
  name,
  jd
) {

  const s =
    SAT[name];

  const dtDays =
    jd -
    J2000_JD;

  const dtYears =
    dtDays /
    365.25;

  const M =
    mod360(
      s.M +
      360*dtDays/s.P
    )
    *
    DEG;

  // approximate apsidal advance
  const w =
    mod360(
      s.w +
      (
        s.Papsis
          ? 360*dtYears/s.Papsis
          : 0
      )
    )
    *
    DEG;

  // approximate nodal regression
  const N =
    mod360(
      s.N -
      (
        s.Pnode
          ? 360*dtYears/s.Pnode
          : 0
      )
    )
    *
    DEG;

  const i =
    s.i *
    DEG;

  const E =
    solveKepler(
      M,
      s.e
    );

  const a =
    s.a *
    1000;

  const rp = [

    a*(
      Math.cos(E)-s.e
    ),

    a*
    Math.sqrt(
      1-s.e*s.e
    )
    *
    Math.sin(E),

    0
  ];

  const q =
    rotateOrbital(
      rp,
      N,
      i,
      w
    );

  if (
    s.frame ===
    'ecliptic'
  ) {

    return q;
  }

  const B =
    laplaceBasis(
      s.ra,
      s.dec
    );

  return [

    B.ex[0]*q[0] +
    B.ey[0]*q[1] +
    B.ez[0]*q[2],

    B.ex[1]*q[0] +
    B.ey[1]*q[1] +
    B.ez[1]*q[2],

    B.ex[2]*q[0] +
    B.ey[2]*q[1] +
    B.ez[2]*q[2]
  ];
}


// ---------------------------------------------------------------------------
// SATELLITE RELATIVE STATE
// ---------------------------------------------------------------------------

function satRelState(
  name,
  date
) {

  const jd =
    jdFromDate(date);


  // The Moon: Meeus lunar theory, velocity by centred difference ±60 s
  if (
    name === 'Moon'
  ) {

    const dtSec =
      deltaTSeconds(date);

    const hm =
      60/DAY;

    const r0 =
      moonRelPos(jd, dtSec);

    const rA =
      moonRelPos(jd-hm, dtSec);

    const rB =
      moonRelPos(jd+hm, dtSec);

    return {
      r: r0,
      v: mul(sub(rB, rA), 1/120)
    };
  }


  // finite difference ±20 sec
  const h =
    20/DAY;

  const r =
    satRelPos(
      name,
      jd
    );

  const a =
    satRelPos(
      name,
      jd-h
    );

  const b =
    satRelPos(
      name,
      jd+h
    );

  return {

    r,

    v:
      mul(
        sub(b,a),
        1/40
      )
  };
}


// ===========================================================================
// THE MOON — MEEUS, ASTRONOMICAL ALGORITHMS, CHAPTER 47
//
// Truncated ELP-2000/82 lunar theory: 60 terms in longitude and distance,
// 60 in latitude. Accuracy ≈ 10" in longitude, ≈ 4" in latitude and a few
// km in distance — against ~20° and ~20 000 km for mean orbital elements.
//
// Output: geocentric ecliptic coordinates, mean equinox OF DATE, then
// precessed (Meeus ch. 21) into the J2000 ecliptic used by the planets.
//
// Series coefficients: Meeus, Table 47.A and 47.B (as tabulated in the
// MIT-licensed `astronomia` library).
// ===========================================================================

const MOON_TA = [   // D, M, M', F, Σl (1e-6 deg), Σr (1e-3 km)
  [0,0,1,0,6288774,-20905355], [2,0,-1,0,1274027,-3699111], [2,0,0,0,658314,-2955968],
  [0,0,2,0,213618,-569925], [0,1,0,0,-185116,48888], [0,0,0,2,-114332,-3149],
  [2,0,-2,0,58793,246158], [2,-1,-1,0,57066,-152138], [2,0,1,0,53322,-170733],
  [2,-1,0,0,45758,-204586], [0,1,-1,0,-40923,-129620], [1,0,0,0,-34720,108743],
  [0,1,1,0,-30383,104755], [2,0,0,-2,15327,10321], [0,0,1,2,-12528,0],
  [0,0,1,-2,10980,79661], [4,0,-1,0,10675,-34782], [0,0,3,0,10034,-23210],
  [4,0,-2,0,8548,-21636], [2,1,-1,0,-7888,24208], [2,1,0,0,-6766,30824],
  [1,0,-1,0,-5163,-8379], [1,1,0,0,4987,-16675], [2,-1,1,0,4036,-12831],
  [2,0,2,0,3994,-10445], [4,0,0,0,3861,-11650], [2,0,-3,0,3665,14403],
  [0,1,-2,0,-2689,-7003], [2,0,-1,2,-2602,0], [2,-1,-2,0,2390,10056],
  [1,0,1,0,-2348,6322], [2,-2,0,0,2236,-9884], [0,1,2,0,-2120,5751],
  [0,2,0,0,-2069,0], [2,-2,-1,0,2048,-4950], [2,0,1,-2,-1773,4130],
  [2,0,0,2,-1595,0], [4,-1,-1,0,1215,-3958], [0,0,2,2,-1110,0],
  [3,0,-1,0,-892,3258], [2,1,1,0,-810,2616], [4,-1,-2,0,759,-1897],
  [0,2,-1,0,-713,-2117], [2,2,-1,0,-700,2354], [2,1,-2,0,691,0],
  [2,-1,0,-2,596,0], [4,0,1,0,549,-1423], [0,0,4,0,537,-1117],
  [4,-1,0,0,520,-1571], [1,0,-2,0,-487,-1739], [2,1,0,-2,-399,0],
  [0,0,2,-2,-381,-4421], [1,1,1,0,351,0], [3,0,-2,0,-340,0],
  [4,0,-3,0,330,0], [2,-1,2,0,327,0], [0,2,1,0,-323,1165],
  [1,1,-1,0,299,0], [2,0,3,0,294,0], [2,0,-1,-2,0,8752]
];

const MOON_TB = [   // D, M, M', F, Σb (1e-6 deg)
  [0,0,0,1,5128122], [0,0,1,1,280602], [0,0,1,-1,277693], [2,0,0,-1,173237],
  [2,0,-1,1,55413], [2,0,-1,-1,46271], [2,0,0,1,32573], [0,0,2,1,17198],
  [2,0,1,-1,9266], [0,0,2,-1,8822], [2,-1,0,-1,8216], [2,0,-2,-1,4324],
  [2,0,1,1,4200], [2,1,0,-1,-3359], [2,-1,-1,1,2463], [2,-1,0,1,2211],
  [2,-1,-1,-1,2065], [0,1,-1,-1,-1870], [4,0,-1,-1,1828], [0,1,0,1,-1794],
  [0,0,0,3,-1749], [0,1,-1,1,-1565], [1,0,0,1,-1491], [0,1,1,1,-1475],
  [0,1,1,-1,-1410], [0,1,0,-1,-1344], [1,0,0,-1,-1335], [0,0,3,1,1107],
  [4,0,0,-1,1021], [4,0,-1,1,833], [0,0,1,-3,777], [4,0,-2,1,671],
  [2,0,0,-3,607], [2,0,2,-1,596], [2,-1,1,-1,491], [2,0,-2,1,-451],
  [0,0,3,-1,439], [2,0,2,1,422], [2,0,-3,-1,421], [2,1,-1,1,-366],
  [2,1,0,1,-351], [4,0,0,1,331], [2,-1,1,1,315], [2,-2,0,-1,302],
  [0,0,1,3,-283], [2,1,1,-1,-229], [1,1,0,-1,223], [1,1,0,1,223],
  [0,1,-2,-1,-220], [2,1,-1,-1,-220], [1,0,1,1,-185], [2,-1,-2,-1,181],
  [0,1,2,1,-177], [4,0,-2,-1,176], [4,-1,-1,-1,166], [1,0,1,-1,-164],
  [4,0,1,-1,132], [1,0,-1,-1,-119], [4,-1,0,-1,115], [2,-2,0,1,107]
];

// ΔT = TT − UT in seconds (Espenak & Meeus polynomials).
// The lunar theory runs on Terrestrial Time; the calendar gives UT.
function deltaTSeconds(
  date
) {

  const y =
    date.getUTCFullYear() +
    (date.getUTCMonth() + 0.5) / 12;

  // measured ΔT has stayed at 69.1–69.4 s since 2017 (IERS); the 2005–2050
  // Espenak–Meeus parabola overshoots it by several seconds today
  if (y >= 2017 && y < 2050) return 69.2;

  if (y >= 2005 && y < 2017) {
    const t = y - 2000;
    return 62.92 + 0.32217*t + 0.005589*t*t;
  }

  if (y >= 1986 && y < 2005) {
    const t = y - 2000;
    return 63.86 + 0.3345*t - 0.060374*t*t + 0.0017275*t**3
         + 0.000651814*t**4 + 0.00002373599*t**5;
  }

  if (y >= 1961 && y < 1986) {
    const t = y - 1975;
    return 45.45 + 1.067*t - t*t/260 - t**3/718;
  }

  if (y >= 1941 && y < 1961) {
    const t = y - 1950;
    return 29.07 + 0.407*t - t*t/233 + t**3/2547;
  }

  // outside 1941–2050: long-term parabola (good to about a minute)
  const u = (y - 1820) / 100;
  return -20 + 32*u*u;
}


// Geocentric ecliptic longitude, latitude (rad) and distance (km) of the
// Moon, mean equinox of date. `jde` is a Julian Ephemeris Day (TT).
function moonEclipticOfDate(
  jde
) {

  const T = (jde - J2000_JD) / CY;

  const poly = (c) =>
    c[0] + T*(c[1] + T*(c[2] + T*(c[3] + T*c[4])));

  const Lp = poly([218.3164477, 481267.88123421, -0.0015786,  1/538841,   -1/65194000]) * DEG;
  const D  = poly([297.8501921, 445267.1114034,  -0.0018819,  1/545868,   -1/113065000]) * DEG;
  const M  = poly([357.5291092, 35999.0502909,   -0.0001536,  1/24490000, 0]) * DEG;
  const Mp = poly([134.9633964, 477198.8675055,   0.0087414,  1/69699,    -1/14712000]) * DEG;
  const F  = poly([93.2720950,  483202.0175233,  -0.0036539, -1/3526000,   1/863310000]) * DEG;

  const A1 = (119.75 + 131.849    * T) * DEG;
  const A2 = ( 53.09 + 479264.290 * T) * DEG;
  const A3 = (313.45 + 481266.484 * T) * DEG;

  // decreasing eccentricity of the Earth's orbit
  const E  = 1 - 0.002516*T - 0.0000074*T*T;
  const Ek = [1, E, E*E];

  let sl = 3958*Math.sin(A1) + 1962*Math.sin(Lp - F) + 318*Math.sin(A2);
  let sr = 0;
  let sb = -2235*Math.sin(Lp) + 382*Math.sin(A3) + 175*Math.sin(A1 - F)
         +   175*Math.sin(A1 + F) + 127*Math.sin(Lp - Mp) - 115*Math.sin(Lp + Mp);

  for (const [d, m, mp, f, cl, cr] of MOON_TA) {
    const arg = d*D + m*M + mp*Mp + f*F;
    const k = Ek[Math.abs(m)];
    sl += cl * k * Math.sin(arg);
    sr += cr * k * Math.cos(arg);
  }

  for (const [d, m, mp, f, cb] of MOON_TB) {
    sb += cb * Ek[Math.abs(m)] * Math.sin(d*D + m*M + mp*Mp + f*F);
  }

  return {
    lon: Lp + sl * 1e-6 * DEG,
    lat: sb * 1e-6 * DEG,
    distKm: 385000.56 + sr * 1e-3
  };
}


// Precession of ecliptic coordinates from the equinox of `jde` back to
// J2000.0 — Meeus, formula 21.5, run from epoch `jde` to J2000.
function eclipticOfDateToJ2000(
  lon,
  lat,
  jde
) {

  const AS = DEG / 3600;               // arcseconds → radians
  const T  = (jde - J2000_JD) / CY;    // starting epoch
  const t  = -T;                       // interval to J2000

  const eta =
    ((47.0029 - 0.06603*T + 0.000598*T*T) * t
    + (-0.03302 + 0.000598*T) * t*t
    + 0.000060 * t*t*t) * AS;

  const Pi =
    174.876384 * DEG
    + (3289.4789*T + 0.60622*T*T) * AS
    - (869.8089 + 0.50491*T) * t * AS
    + 0.03536 * t*t * AS;

  const p =
    ((5029.0966 + 2.22226*T - 0.000042*T*T) * t
    + (1.11113 - 0.000042*T) * t*t
    - 0.000006 * t*t*t) * AS;

  const A = Math.cos(eta)*Math.cos(lat)*Math.sin(Pi - lon) - Math.sin(eta)*Math.sin(lat);
  const B = Math.cos(lat)*Math.cos(Pi - lon);
  const C = Math.cos(eta)*Math.sin(lat) + Math.sin(eta)*Math.cos(lat)*Math.sin(Pi - lon);

  return {
    lon: p + Pi - Math.atan2(A, B),
    lat: Math.asin(Math.max(-1, Math.min(1, C)))
  };
}


// Geocentric position of the Moon in metres, J2000 ecliptic frame.
// `jdUT` is the calendar Julian Day (UT); ΔT is added here.
function moonRelPos(
  jdUT,
  dtSec
) {

  const jde = jdUT + dtSec / DAY;

  const m = moonEclipticOfDate(jde);
  const q = eclipticOfDateToJ2000(m.lon, m.lat, jde);

  const r = m.distKm * 1000;

  return [
    r * Math.cos(q.lat) * Math.cos(q.lon),
    r * Math.cos(q.lat) * Math.sin(q.lon),
    r * Math.sin(q.lat)
  ];
}


// ===========================================================================
// BODY ORDER
// This is also the order shown in NASSCAD Objects.
// ===========================================================================

const ORDER = [

  'Sun',

  'Mercury',
  'Venus',

  'Earth',
  'Moon',

  'Mars',
  'Phobos',
  'Deimos',

  'Jupiter',
  'Io',
  'Europa',
  'Ganymede',
  'Callisto',

  'Saturn',
  'Mimas',
  'Enceladus',
  'Tethys',
  'Dione',
  'Rhea',
  'Titan',
  'Iapetus',

  'Uranus',
  'Neptune'
];


// ---------------------------------------------------------------------------
// PHYSICAL BODY INSTANCES
// ---------------------------------------------------------------------------

const bodies =
  ORDER.map(
    name => ({
      name,
      ...META[name],

      r:V(),
      v:V(),
      a:V(),

      mesh:null,
      nassObj:null,

      trail:[]
    })
  );

const byName =
  new Map(
    bodies.map(
      b => [
        b.name,
        b
      ]
    )
  );


// ===========================================================================
// INITIALIZE A REAL CALENDAR DATE
// ===========================================================================

function seedSystemAt(
  date
) {

  const year =
    date.getUTCFullYear();

  if (
    year < 1800 ||
    year > 2050
  ) {

    nasLog(
      'WARN',
      `Solar date ${year}: planetary JPL coefficients are calibrated for 1800–2050`
    );
  }


  const Sun =
    byName.get(
      'Sun'
    );

  Sun.r=V();
  Sun.v=V();


  // heliocentric system states
  const base = {

    Mercury:
      planetState(
        'Mercury',
        date
      ),

    Venus:
      planetState(
        'Venus',
        date
      ),

    EMB:
      planetState(
        'EMB',
        date
      ),

    Mars:
      planetState(
        'Mars',
        date
      ),

    Jupiter:
      planetState(
        'Jupiter',
        date
      ),

    Saturn:
      planetState(
        'Saturn',
        date
      ),

    Uranus:
      planetState(
        'Uranus',
        date
      ),

    Neptune:
      planetState(
        'Neptune',
        date
      )
  };


  // -----------------------------------------------------------------------
  // Reconstruct planet + moons while preserving the seed system barycentre.
  //
  // Example Earth:
  //
  // Earth ←──── barycentre ────→ Moon
  //
  // Rather than simply placing the Moon around a fixed Earth,
  // BOTH Earth and Moon orbit their common barycentre.
  // -----------------------------------------------------------------------

  function attach(
    parentName,
    baseState,
    moonNames
  ) {

    const p =
      byName.get(
        parentName
      );

    const rel =
      moonNames.map(
        n => ({
          b:byName.get(n),
          s:satRelState(
            n,
            date
          )
        })
      );


    let total =
      p.mass;

    let cr =
      V();

    let cv =
      V();


    for (
      const x of rel
    ) {

      total +=
        x.b.mass;

      cr =
        add(
          cr,
          mul(
            x.s.r,
            x.b.mass
          )
        );

      cv =
        add(
          cv,
          mul(
            x.s.v,
            x.b.mass
          )
        );
    }


    cr =
      mul(
        cr,
        1/total
      );

    cv =
      mul(
        cv,
        1/total
      );


    p.r =
      sub(
        baseState.r,
        cr
      );

    p.v =
      sub(
        baseState.v,
        cv
      );


    for (
      const x of rel
    ) {

      x.b.r =
        add(
          p.r,
          x.s.r
        );

      x.b.v =
        add(
          p.v,
          x.s.v
        );
    }
  }


  // planets without modeled satellites

  byName.get('Mercury').r =
    base.Mercury.r.slice();

  byName.get('Mercury').v =
    base.Mercury.v.slice();


  byName.get('Venus').r =
    base.Venus.r.slice();

  byName.get('Venus').v =
    base.Venus.v.slice();


  byName.get('Uranus').r =
    base.Uranus.r.slice();

  byName.get('Uranus').v =
    base.Uranus.v.slice();


  byName.get('Neptune').r =
    base.Neptune.r.slice();

  byName.get('Neptune').v =
    base.Neptune.v.slice();


  // Earth–Moon barycentric pair

  attach(
    'Earth',
    base.EMB,
    [
      'Moon'
    ]
  );


  // Mars system

  attach(
    'Mars',
    base.Mars,
    [
      'Phobos',
      'Deimos'
    ]
  );


  // Jupiter system

  attach(
    'Jupiter',
    base.Jupiter,
    [
      'Io',
      'Europa',
      'Ganymede',
      'Callisto'
    ]
  );


  // Saturn system

  attach(
    'Saturn',
    base.Saturn,
    [
      'Mimas',
      'Enceladus',
      'Tethys',
      'Dione',
      'Rhea',
      'Titan',
      'Iapetus'
    ]
  );


  // -----------------------------------------------------------------------
  // TRUE BARYCENTRIC FRAME OF OUR SIMULATED SUBSET
  // -----------------------------------------------------------------------

  let M=0;

  let R=
    V();

  let P=
    V();


  for (
    const b of bodies
  ) {

    M +=
      b.mass;

    R =
      add(
        R,
        mul(
          b.r,
          b.mass
        )
      );

    P =
      add(
        P,
        mul(
          b.v,
          b.mass
        )
      );
  }


  R =
    mul(
      R,
      1/M
    );

  P =
    mul(
      P,
      1/M
    );


  for (
    const b of bodies
  ) {

    b.r =
      sub(
        b.r,
        R
      );

    b.v =
      sub(
        b.v,
        P
      );

    b.a =
      V();
  }
}


// ===========================================================================
// J2 — PLANET OBLATENESS
//
// Important for close satellites:
// Phobos, Io, Mimas, Enceladus, etc.
//
// Still classical Newtonian gravity — but planet is not treated as a
// mathematically perfect sphere.
// ===========================================================================

function addJ2Acceleration(
  moon,
  parent
) {

  if (
    !CFG.useJ2 ||
    !parent.j2 ||
    !parent.eqRadiusKm
  )
    return;


  const r =
    sub(
      moon.r,
      parent.r
    );

  const r2 =
    dot(
      r,
      r
    );

  const rr =
    Math.sqrt(
      r2
    );

  if (
    rr < 1
  )
    return;


  // pole direction is constant: computed once per planet, then cached
  const k =
    parent._pole ||
    (parent._pole = eqPoleToEcl(parent.poleRA, parent.poleDec));


  const z =
    dot(
      r,
      k
    );


  const q =
    z*z/r2;


  const mu =
    G *
    parent.mass;


  const R =
    parent.eqRadiusKm *
    1000;


  const coeff =
    1.5 *
    parent.j2 *
    mu *
    R*R
    /
    (
      r2*r2*rr
    );


  const f =
    5*q -
    1;


  // in place: no allocation in the physics hot path
  const back =
    moon.mass /
    parent.mass;

  for (
    let c=0;
    c<3;
    c++
  ) {

    const aj =
      coeff *
      (
        r[c]*f -
        2*z*k[c]
      );

    moon.a[c] +=
      aj;

    // approximate equal/opposite reaction
    parent.a[c] -=
      aj*back;
  }
}


// ===========================================================================
// NEWTON N-BODY GRAVITY
// ===========================================================================

function computeAccelerations() {

  for (
    const b of bodies
  ) {

    b.a[0]=0;
    b.a[1]=0;
    b.a[2]=0;
  }


  // exact pairwise Newtonian interactions
  for (
    let i=0;
    i<bodies.length;
    i++
  ) {

    const a =
      bodies[i];


    for (
      let j=i+1;
      j<bodies.length;
      j++
    ) {

      const b =
        bodies[j];


      const d0 =
        b.r[0]-a.r[0];

      const d1 =
        b.r[1]-a.r[1];

      const d2 =
        b.r[2]-a.r[2];


      const r2 =
        d0*d0 +
        d1*d1 +
        d2*d2;


      if (
        r2 < 1
      )
        continue;


      const invr3 =
        1 /
        (
          r2 *
          Math.sqrt(r2)
        );


      const fa =
        G *
        b.mass *
        invr3;


      const fb =
        G *
        a.mass *
        invr3;


      a.a[0] +=
        fa*d0;

      a.a[1] +=
        fa*d1;

      a.a[2] +=
        fa*d2;


      b.a[0] -=
        fb*d0;

      b.a[1] -=
        fb*d1;

      b.a[2] -=
        fb*d2;
    }
  }


  // oblateness of parent planets
  for (
    const b of bodies
  ) {

    if (
      b.kind ===
      'moon'
    ) {

      addJ2Acceleration(
        b,
        byName.get(
          b.parent
        )
      );
    }
  }


  // -----------------------------------------------------------------------
  // OPTIONAL SOLAR 1PN
  // -----------------------------------------------------------------------

  if (
    CFG.useGR
  ) {

    const sun =
      byName.get(
        'Sun'
      );

    const C =
      299792458;


    for (
      const b of bodies
    ) {

      if (
        b.kind !==
        'planet'
      )
        continue;


      const r =
        sub(
          b.r,
          sun.r
        );

      const v =
        sub(
          b.v,
          sun.v
        );


      const R =
        len(r);


      const mu =
        G *
        (
          sun.mass +
          b.mass
        );


      const rv =
        dot(
          r,
          v
        );

      const v2 =
        dot(
          v,
          v
        );


      const c =
        mu /
        (
          C*C*
          R*R*R
        );


      const A =
        4*mu/R -
        v2;


      const ag = [

        c*
        (
          A*r[0] +
          4*rv*v[0]
        ),

        c*
        (
          A*r[1] +
          4*rv*v[1]
        ),

        c*
        (
          A*r[2] +
          4*rv*v[2]
        )
      ];


      for (
        let c=0;
        c<3;
        c++
      ) {

        b.a[c] +=
          ag[c];

        sun.a[c] -=
          ag[c] *
          b.mass /
          sun.mass;
      }
    }
  }
}


// ===========================================================================
// VELOCITY VERLET
// ===========================================================================

function physicsStep(
  dt
) {

  // previous accelerations, copied into per-body buffers (no allocation)
  for (
    const b of bodies
  ) {

    const a0 =
      b.a0 ||
      (b.a0 = [0,0,0]);

    a0[0] = b.a[0];
    a0[1] = b.a[1];
    a0[2] = b.a[2];
  }


  const h =
    0.5 *
    dt *
    dt;


  // positions

  for (
    let i=0;
    i<bodies.length;
    i++
  ) {

    const b =
      bodies[i];

    const a =
      b.a0;


    b.r[0] +=
      b.v[0]*dt +
      a[0]*h;

    b.r[1] +=
      b.v[1]*dt +
      a[1]*h;

    b.r[2] +=
      b.v[2]*dt +
      a[2]*h;
  }


  // new acceleration

  computeAccelerations();


  // velocities

  for (
    let i=0;
    i<bodies.length;
    i++
  ) {

    const b =
      bodies[i];

    const a0 =
      b.a0;

    const a1 =
      b.a;


    b.v[0] +=
      0.5 *
      (
        a0[0]+a1[0]
      )
      *
      dt;


    b.v[1] +=
      0.5 *
      (
        a0[1]+a1[1]
      )
      *
      dt;


    b.v[2] +=
      0.5 *
      (
        a0[2]+a1[2]
      )
      *
      dt;
  }
}


// ===========================================================================
// ENERGY DIAGNOSTIC
// ===========================================================================

function totalNewtonianEnergy() {

  let E=0;


  for (
    const b of bodies
  ) {

    E +=
      0.5 *
      b.mass *
      dot(
        b.v,
        b.v
      );
  }


  for (
    let i=0;
    i<bodies.length;
    i++
  ) {

    for (
      let j=i+1;
      j<bodies.length;
      j++
    ) {

      E -=

        G *

        bodies[i].mass *

        bodies[j].mass

        /

        len(
          sub(
            bodies[j].r,
            bodies[i].r
          )
        );
    }
  }


  return E;
}


// ===========================================================================
// VISUAL MAPPING
//
// PHYSICS remains in SI metres.
// Only the rendering is compressed.
//
// Planets use global asinh compression.
// Moons use a second local scale around their real parent.
// ===========================================================================

function displayGlobal(
  r
) {

  const R =
    len(r);


  if (
    !R
  )
    return new THREE.Vector3();


  const d =

    CFG.planetScale *

    Math.asinh(
      (
        R/AU
      )
      /
      CFG.planetCompressionAU
    );


  const f =
    d/R;


  // physical J2000 ecliptic:
  // x,y,z
  //
  // NASSCAD:
  // X horizontal
  // Y vertical
  // Z depth

  return new THREE.Vector3(

    r[0]*f,

    r[2]*f,

    r[1]*f
  );
}


function displayMoon(
  b
) {

  const p =
    byName.get(
      b.parent
    );


  const parentPos =
    p.mesh
      ? p.mesh.position
      : displayGlobal(
          p.r
        );


  const r =
    sub(
      b.r,
      p.r
    );


  const R =
    len(r);


  if (
    !R
  )
    return parentPos.clone();


  const km =
    R /
    1000;


  const d =

    CFG.moonLocalBase +

    CFG.moonLocalScale *

    Math.asinh(
      km /
      CFG.moonCompressionKm
    );


  const f =
    d/R;


  return (

    parentPos
      .clone()
      .add(

        new THREE.Vector3(

          r[0]*f,

          r[2]*f,

          r[1]*f
        )
      )
  );
}


// ---------------------------------------------------------------------------
// DISPLAY BODY SIZE
// ---------------------------------------------------------------------------

function displayRadius(
  b
) {

  if (
    b.kind ===
    'sun'
  )
    return 14;


  if (
    b.kind ===
    'planet'
  ) {

    return Math.max(

      0.75,

      Math.min(

        5.2,

        1.45 *

        Math.cbrt(
          b.radiusKm /
          6371.0084
        )
      )
    );
  }


  return Math.max(

    0.22,

    Math.min(

      1.35,

      0.52 *

      Math.cbrt(
        b.radiusKm /
        1737.4
      )
    )
  );
}


// ===========================================================================
// BACKGROUND
// ===========================================================================

const oldBackground =
  scene.background;

scene.background =
  new THREE.Color(
    0x000006
  );


// ---------------------------------------------------------------------------
// DEMO ENVIRONMENT — night theme, no work plane
//
// Both go through NASSCAD's own state, so nothing brings them back by
// accident (a theme rebuild re-creates the grid from _gridVisible), and
// both are restored by destroy(). The theme change is NOT saved to the
// user's settings.
// ---------------------------------------------------------------------------

function applyTheme(dark) {

  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');

  const tb = document.getElementById('thm-btn');
  if (tb) tb.textContent = dark ? '☀ Day' : '🌙 Night';

  for (const fn of ['updColors', 'buildGrid', 'buildAxes', 'buildNavCube', '_gizBuildPlate']) {
    if (typeof window[fn] === 'function') {
      try { window[fn](); } catch (e) { /* cosmetic only */ }
    }
  }

  _camDirty = true;
}

const hadGrid =
  typeof _gridVisible !== 'undefined'
    ? _gridVisible
    : !!(typeof _gridGroup !== 'undefined' && _gridGroup && _gridGroup.visible);

if (hadGrid) {
  if (typeof toggleGrid === 'function') toggleGrid();
  else if (typeof _gridGroup !== 'undefined' && _gridGroup) _gridGroup.visible = false;
}

const wasDark =
  document.documentElement.getAttribute('data-theme') === 'dark';

if (!wasDark)
  applyTheme(true);


// ---------------------------------------------------------------------------
// DETERMINISTIC STAR FIELD
// ---------------------------------------------------------------------------

let seed =
  0x4e415353;


function rnd() {

  seed |= 0;

  seed =
    seed +
    0x6D2B79F5
    |
    0;

  let t =
    seed;

  t =
    Math.imul(
      t^t>>>15,
      t|1
    );

  t ^=
    t +
    Math.imul(
      t^t>>>7,
      t|61
    );

  return (

    (
      t^t>>>14
    )
    >>>
    0

  )
  /
  4294967296;
}


const sp =
  new Float32Array(
    CFG.stars*3
  );

const sc =
  new Float32Array(
    CFG.stars*3
  );


for (
  let i=0;
  i<CFG.stars;
  i++
) {

  const u =
    rnd();

  const v =
    rnd();

  const th =
    2*Math.PI*u;

  const z =
    2*v-1;

  const q =
    Math.sqrt(
      1-z*z
    );

  const R =
    720 +
    rnd()*480;

  const k =
    i*3;


  sp[k] =
    R*q*Math.cos(th);

  sp[k+1] =
    R*z;

  sp[k+2] =
    R*q*Math.sin(th);


  const t =
    rnd();


  if (
    t < 0.10
  ) {

    sc[k]=0.65;
    sc[k+1]=0.78;
    sc[k+2]=1.0;

  }
  else if (
    t < 0.20
  ) {

    sc[k]=1.0;
    sc[k+1]=0.83;
    sc[k+2]=0.60;

  }
  else {

    const c =
      0.70 +
      rnd()*0.30;

    sc[k]=c;
    sc[k+1]=c;
    sc[k+2]=c;
  }
}


const starGeo =
  new THREE.BufferGeometry();


starGeo.setAttribute(

  'position',

  new THREE.BufferAttribute(
    sp,
    3
  )
);


starGeo.setAttribute(

  'color',

  new THREE.BufferAttribute(
    sc,
    3
  )
);


const starMat =
  new THREE.PointsMaterial({

    size:1.45,

    sizeAttenuation:true,

    vertexColors:true,

    transparent:true,

    opacity:0.94
  });


const starField =
  new THREE.Points(
    starGeo,
    starMat
  );


scene.add(
  starField
);


// ===========================================================================
// CREATE TRUE NASSCAD OBJECTS
//
// This is the key difference from the earlier version.
//
// Every celestial body gets:
//
//    scene.add(mesh)
//    objs.push(record)
//
// so it appears in NASSCAD's Objects panel.
// ===========================================================================

function makeOfficialObject(
  b
) {

  const seg =

    b.kind==='sun'

      ? 64

      : (
          b.kind==='planet'
            ? 40
            : 24
        );


  // Use NASSCAD's normal PS-sized sphere basis.
  // Visual size lives in mesh.scale.
  const geo =

    new THREE.SphereGeometry(

      PS/2,

      seg,

      Math.max(
        12,
        Math.round(
          seg*0.65
        )
      )
    );


  const mat =

    new THREE.MeshPhongMaterial({

      color:b.color,

      shininess:
        b.kind==='sun'
          ? 2
          : 8,

      emissive:
        b.kind==='sun'
          ? 0xff7600
          : 0x000000,

      emissiveIntensity:
        b.kind==='sun'
          ? 1
          : 0
    });


  const mesh =
    new THREE.Mesh(
      geo,
      mat
    );


  const s =
    displayRadius(b)
    /
    (
      PS/2
    );


  mesh.scale.setScalar(
    s
  );


  mesh.castShadow=true;
  mesh.receiveShadow=false;


  scene.add(
    mesh
  );


  // ---------------------------------------------------------
  // Official NASSCAD object
  // ---------------------------------------------------------

  objCnt++;


  const o = {

    id:objCnt,

    name:b.name,

    // Real NASSCAD type → normal selection / properties / persistence
    type:'sphere',

    mesh,

    color:b.color,

    isHole:false,

    sphereRes:seg,


    // Extra metadata.
    // NASSCAD permits enriched object records.
    astro:{

      engine:
        'NASS_SOLAR_REAL',

      kind:
        b.kind,

      parent:
        b.parent || null,

      massKg:
        b.mass,

      radiusKm:
        b.radiusKm,

      physicalPositionM:
        b.r,

      physicalVelocityMS:
        b.v
    }
  };


  objs.push(
    o
  );


  b.mesh =
    mesh;

  b.nassObj =
    o;


  // ---------------------------------------------------------
  // SATURN RINGS
  // ---------------------------------------------------------

  if (
    b.rings
  ) {

    const rg =
      new THREE.RingGeometry(

        (PS/2)*1.35,

        (PS/2)*2.30,

        128
      );


    const rm =
      new THREE.MeshBasicMaterial({

        color:0xc8b88d,

        side:
          THREE.DoubleSide,

        transparent:true,

        opacity:0.62
      });


    const ring =
      new THREE.Mesh(
        rg,
        rm
      );


    ring.rotation.x =
      Math.PI/2;


    mesh.add(
      ring
    );
  }


  // ---------------------------------------------------------
  // TRAIL
  // ---------------------------------------------------------

  if (
    CFG.trails &&
    b.kind !== 'sun'
  ) {

    const tg =
      new THREE.BufferGeometry();


    const tm =
      new THREE.LineBasicMaterial({

        color:b.color,

        transparent:true,

        opacity:
          b.kind==='moon'
            ? 0.30
            : 0.20
      });


    const tl =
      new THREE.Line(
        tg,
        tm
      );


    scene.add(
      tl
    );


    b.trailGeo=
      tg;

    b.trailMat=
      tm;

    b.trailLine=
      tl;

    b.lastTrailSim=
      -Infinity;
  }
}


// create in Objects-panel order

for (
  const b of bodies
)
  makeOfficialObject(b);


// ---------------------------------------------------------------------------
// SOLAR LIGHT
// ---------------------------------------------------------------------------

const solarLight =

  new THREE.PointLight(

    0xffffff,

    2.0,

    0,

    2
  );


scene.add(
  solarLight
);


// ---------------------------------------------------------------------------
// ONE UI REFRESH — not every frame
// ---------------------------------------------------------------------------

selObjs=[];

updOList();
updStats();
updProps();


// ===========================================================================
// HUD
// ===========================================================================

let hud=null;


if (
  CFG.showHUD
) {

  hud =
    document.createElement(
      'div'
    );


  hud.id =
    'nass-solar-hud';


  hud.style.cssText =

    'position:fixed;' +
    'left:50%;' +
    'top:42px;' +
    'transform:translateX(-50%);' +
    'z-index:9998;' +
    'pointer-events:none;' +

    'background:rgba(2,8,20,.72);' +
    'border:1px solid rgba(92,160,255,.35);' +
    'border-radius:7px;' +

    'padding:6px 10px;' +

    'color:#dcecff;' +

    'font:11px/1.35 monospace;' +

    'white-space:pre;' +
    'text-align:center;' +

    'backdrop-filter:blur(4px)';


  document.body.appendChild(
    hud
  );
}


// ===========================================================================
// PUBLIC STATE
// ===========================================================================

const state = {

  alive:true,

  paused:false,

  bodies,

  byName,

  epoch:
    CFG.defaultDate,

  simSeconds:0,

  accumulator:0,

  daysPerSecond:
    CFG.daysPerSecond,

  lastReal:
    performance.now(),

  initialEnergy:0,

  energyDrift:0,

  followName:null,

  lastUI:0,

  lastDiag:0,

  // simulated days per real second actually achieved (smoothed)
  achievedDaysPerSecond:null
};


window.NASS_SOLAR_REAL =
  state;


// ---------------------------------------------------------------------------
// CURRENT SIMULATION CALENDAR DATE
// ---------------------------------------------------------------------------

function currentDate() {

  return new Date(

    state.epoch.getTime()

    +

    state.simSeconds*
    1000
  );
}


// ---------------------------------------------------------------------------
// TRAILS
// ---------------------------------------------------------------------------

function clearTrails() {

  for (
    const b of bodies
  ) {

    b.trail=[];

    b.lastTrailSim=
      -Infinity;


    if (
      b.trailGeo
    )
      b.trailGeo.setFromPoints([]);
  }
}


// ---------------------------------------------------------------------------
// UPDATE VISUAL POSITIONS
// ---------------------------------------------------------------------------

function updateVisuals() {

  for (
    const b of bodies
  ) {

    const p =

      b.kind==='moon'

        ? displayMoon(b)

        : displayGlobal(
            b.r
          );


    b.mesh.position.copy(
      p
    );


    if (
      b.tilt
    )
      b.mesh.rotation.z =
        b.tilt *
        DEG;


    if (
      b.rotationHours
    ) {

      const dir =
        b.rotationHours < 0
          ? -1
          : 1;


      b.mesh.rotation.y =

        dir *

        (
          state.simSeconds
          /
          (
            Math.abs(
              b.rotationHours
            )
            *
            3600
          )
        )

        *

        Math.PI*2;
    }


    if (
      typeof _invalidateBbox ===
      'function'
    ) {

      _invalidateBbox(
        b.mesh
      );
    }
  }


  solarLight.position.copy(

    byName
      .get('Sun')
      .mesh
      .position
  );


  // camera tracking

  if (
    state.followName &&
    byName.has(
      state.followName
    )
  ) {

    camT.copy(

      byName
        .get(
          state.followName
        )
        .mesh
        .position
    );

    updCam();
  }


  _camDirty=true;
}


// ---------------------------------------------------------------------------
// TRAIL SAMPLING
// ---------------------------------------------------------------------------

function sampleTrails() {

  if (
    !CFG.trails
  )
    return;


  for (
    const b of bodies
  ) {

    if (
      !b.trailGeo
    )
      continue;


    const step =

      (
        b.kind==='moon'

          ? CFG.trailSampleMoonDays

          : CFG.trailSamplePlanetDays
      )

      *

      DAY;


    if (
      Math.abs(
        state.simSeconds -
        b.lastTrailSim
      )
      <
      step
    )
      continue;


    b.lastTrailSim =
      state.simSeconds;


    const p =

      b.kind==='moon'

        ? displayMoon(b)

        : displayGlobal(
            b.r
          );


    b.trail.push(
      p.clone()
    );


    const cap =

      b.kind==='moon'

        ? CFG.trailPointsMoon

        : CFG.trailPointsPlanet;


    if (
      b.trail.length >
      cap
    )
      b.trail.shift();


    b.trailGeo.setFromPoints(
      b.trail
    );
  }
}


// ===========================================================================
// CHANGE CALENDAR DATE
// ===========================================================================

function seedDate(
  date
) {

  const d =

    date instanceof Date

      ? date

      : new Date(
          date
        );


  if (
    !Number.isFinite(
      d.getTime()
    )
  )
    throw new Error(
      'Invalid date'
    );


  seedSystemAt(
    d
  );


  state.epoch =
    new Date(
      d.getTime()
    );


  state.simSeconds=0;

  state.accumulator=0;


  // Refresh pointers in NASSCAD metadata

  for (
    const b of bodies
  ) {

    if (
      b.nassObj &&
      b.nassObj.astro
    ) {

      b.nassObj.astro.physicalPositionM =
        b.r;

      b.nassObj.astro.physicalVelocityMS =
        b.v;
    }
  }


  computeAccelerations();


  state.initialEnergy =
    totalNewtonianEnergy();


  state.energyDrift=0;


  clearTrails();

  updateVisuals();

  sampleTrails();


  nasLog(
    'OK',
    'Solar System date → '+
    d.toISOString()
  );


  return state.status();
}


// ===========================================================================
// PUBLIC COMMANDS
// ===========================================================================

state.setDate =
  x =>
    seedDate(x);


// console commands and on-screen buttons stay in sync
function synced(fn) {
  return (...args) => {
    const r = fn(...args);
    if (state._refreshControls) state._refreshControls();
    return r;
  };
}


state.now =
  () =>
    seedDate(
      new Date()
    );


state.date =
  () =>
    currentDate();


state.pause =
  () => {

    state.paused=true;

    return 'paused';
  };


state.resume =
  () => {

    state.paused=false;

    state.lastReal=
      performance.now();

    return 'running';
  };


state.speed =
  dps => {

    const n =
      Number(dps);


    if (
      !Number.isFinite(n)
    )
      throw new Error(
        'speed must be numeric'
      );


    state.daysPerSecond =

      Math.max(
        -20,

        Math.min(
          20,
          n
        )
      );


    return state.daysPerSecond;
  };


// ---------------------------------------------------------------------------
// FOLLOW BODY
// ---------------------------------------------------------------------------

state.follow =
  name => {

    if (
      name==null ||
      name===''
    ) {

      state.followName=null;

      // back to the overview framing used at launch
      camT.set(
        0,
        0,
        0
      );

      camA.theta = 0.72;
      camA.phi   = 1.02;
      camA.dist  = 510;

      updCam();

      return null;
    }


    const key =

      [...byName.keys()]
        .find(
          k =>
            k.toLowerCase()
            ===
            String(name)
              .toLowerCase()
        );


    if (
      !key
    )
      throw new Error(
        'Unknown body: '+
        name
      );


    state.followName =
      key;


    camT.copy(

      byName
        .get(key)
        .mesh
        .position
    );


    camA.dist =

      byName
        .get(key)
        .kind==='moon'

        ? 45

        : 75;


    updCam();


    return key;
  };


// typed in the console or clicked on screen: the control bar follows
state.speed  = synced(state.speed);
state.pause  = synced(state.pause);
state.resume = synced(state.resume);
state.follow = synced(state.follow);


// ---------------------------------------------------------------------------
// STATUS
// ---------------------------------------------------------------------------

state.status =
  () => ({

    date:
      currentDate()
        .toISOString(),

    speed_days_per_real_second:
      state.daysPerSecond,

    achieved_days_per_real_second:
      state.achievedDaysPerSecond == null
        ? null
        : +state.achievedDaysPerSecond.toFixed(3),

    moon_distance_km:
      Math.round(
        len(
          sub(
            byName.get('Moon').r,
            byName.get('Earth').r
          )
        ) / 1000
      ),

    timestep_seconds:
      CFG.dtSeconds,

    bodies:
      bodies.length,

    objects_registered:
      bodies
        .filter(
          b =>
            objs.includes(
              b.nassObj
            )
        )
        .length,

    Newtonian_energy_drift:
      state.energyDrift,

    J2:
      CFG.useJ2,

    GR_1PN:
      CFG.useGR,

    follow:
      state.followName
  });


// ===========================================================================
// CLEANUP
// ===========================================================================

state.destroy =
  (
    silent=false
  ) => {

    if (
      !state.alive
    )
      return;


    state.alive=false;


    const our =
      new Set(
        bodies.map(
          b =>
            b.nassObj
        )
      );


    selObjs =
      selObjs.filter(
        o =>
          !our.has(o)
      );


    for (
      const b of bodies
    ) {

      // trail

      if (
        b.trailLine
      ) {

        scene.remove(
          b.trailLine
        );

        b.trailGeo.dispose();

        b.trailMat.dispose();
      }


      // actual NASSCAD mesh

      if (
        b.mesh
      ) {

        scene.remove(
          b.mesh
        );


        // children such as Saturn's ring

        b.mesh.traverse(
          x => {

            if (
              x !== b.mesh &&
              x.geometry
            )
              x.geometry.dispose();


            if (
              x !== b.mesh &&
              x.material
            ) {

              (
                Array.isArray(
                  x.material
                )

                  ? x.material

                  : [x.material]

              ).forEach(

                m =>
                  m.dispose &&
                  m.dispose()
              );
            }
          }
        );


        b.mesh.geometry.dispose();


        (
          Array.isArray(
            b.mesh.material
          )

            ? b.mesh.material

            : [b.mesh.material]

        ).forEach(

          m =>
            m.dispose &&
            m.dispose()
        );
      }
    }


    objs =
      objs.filter(
        o =>
          !our.has(o)
      );


    scene.remove(
      starField
    );

    starGeo.dispose();

    starMat.dispose();


    scene.remove(
      solarLight
    );


    if (
      hud &&
      hud.parentNode
    )
      hud.remove();


    if (
      state._ctl &&
      state._ctl.parentNode
    )
      state._ctl.remove();


    scene.background =
      oldBackground;


    if (
      !wasDark
    )
      applyTheme(false);


    if (
      hadGrid
    ) {

      if (typeof toggleGrid === 'function') {
        if (typeof _gridVisible === 'undefined' || !_gridVisible) toggleGrid();
      }
      else if (typeof _gridGroup !== 'undefined' && _gridGroup)
        _gridGroup.visible = true;
    }


    updOList();
    updStats();
    updProps();


    _camDirty=true;


    if (
      window.NASS_SOLAR_REAL ===
      state
    )
      delete window.NASS_SOLAR_REAL;


    if (
      !silent
    )
      nasLog(
        'OK',
        'Solar System removed'
      );
  };


// ===========================================================================
// ON-SCREEN CONTROLS
//
// « / »  slower / faster along a fixed ladder of speeds (negative = time
//        runs backwards) · ⏸ / ▶ pause and resume · Now re-seeds today's
//        sky · the list makes the camera follow a body · ✕ removes the demo.
// Everything here only calls the public commands above.
// ===========================================================================

const SPEEDS = [
  -20, -10, -5, -2, -1, -0.5, -0.1, -0.01,
   0.01, 0.1, 0.5, 1, 2, 5, 10, 20
];

function speedIndex() {

  let best = 0;

  for (let i = 1; i < SPEEDS.length; i++) {
    if (Math.abs(SPEEDS[i] - state.daysPerSecond) <
        Math.abs(SPEEDS[best] - state.daysPerSecond))
      best = i;
  }

  return best;
}

function speedLabel(dps) {

  const a = Math.abs(dps);

  const txt =
    a >= 1    ? a + ' day/s'
    : a >= 0.1 ? (a*24).toFixed(a === 0.5 ? 0 : 1) + ' h/s'
    :            Math.round(a*1440) + ' min/s';

  return (dps < 0 ? '− ' : '') + txt;
}

const ctl =
  document.createElement('div');

ctl.id =
  'nass-solar-ctl';

ctl.style.cssText =
  'position:fixed;left:50%;bottom:44px;transform:translateX(-50%);' +
  'z-index:9998;display:flex;align-items:center;gap:6px;' +
  'background:rgba(2,8,20,.80);border:1px solid rgba(92,160,255,.35);' +
  'border-radius:8px;padding:6px 8px;color:#dcecff;' +
  'font:12px/1 monospace;backdrop-filter:blur(4px);user-select:none';

const BTN =
  'background:rgba(92,160,255,.14);color:#dcecff;' +
  'border:1px solid rgba(92,160,255,.40);border-radius:5px;' +
  'padding:5px 9px;font:12px/1 monospace;cursor:pointer';

function button(label, title, onClick) {

  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  b.title = title;
  b.style.cssText = BTN;
  b.addEventListener('click', ev => { ev.stopPropagation(); onClick(); refreshControls(); });
  ctl.appendChild(b);
  return b;
}

const btnSlower = button('«', 'Slower (past zero, time runs backwards)', () =>
  state.speed(SPEEDS[Math.max(0, speedIndex() - 1)]));

const btnPause = button('||', 'Pause / resume', () =>
  state.paused ? state.resume() : state.pause());

const btnFaster = button('»', 'Faster', () =>
  state.speed(SPEEDS[Math.min(SPEEDS.length - 1, speedIndex() + 1)]));

const speedOut = document.createElement('span');
speedOut.style.cssText = 'min-width:92px;text-align:center';
ctl.insertBefore(speedOut, btnFaster);

button('Now', "Back to today's date", () => state.now());

const followSel = document.createElement('select');
followSel.title = 'Camera follows';
// color-scheme:dark makes the browser draw the opened list dark too;
// each option is also coloured explicitly for browsers that ignore it
followSel.style.cssText = BTN + ';padding:4px 6px;color-scheme:dark';

function addFollowOption(label, value) {
  const o = new Option(label, value);
  o.style.background = '#0b1426';
  o.style.color = '#dcecff';
  followSel.add(o);
}

addFollowOption('Follow: none', '');
for (const b of bodies) addFollowOption(b.name, b.name);
followSel.addEventListener('change', () => state.follow(followSel.value || null));
followSel.addEventListener('mousedown', ev => ev.stopPropagation());
ctl.appendChild(followSel);

button('✕', 'Remove the Solar System', () => state.destroy());

// clicks on the bar must not reach the viewport (no deselection, no orbit)
ctl.addEventListener('mousedown', ev => ev.stopPropagation());
ctl.addEventListener('wheel', ev => ev.stopPropagation());

function refreshControls() {

  if (!state.alive) return;

  speedOut.textContent = speedLabel(state.daysPerSecond);
  btnPause.textContent = state.paused ? '▶' : '||';
  btnSlower.disabled = speedIndex() === 0;
  btnFaster.disabled = speedIndex() === SPEEDS.length - 1;
  btnSlower.style.opacity = btnSlower.disabled ? .4 : 1;
  btnFaster.style.opacity = btnFaster.disabled ? .4 : 1;
  followSel.value = state.followName || '';
}

document.body.appendChild(ctl);

state._ctl = ctl;
state._refreshControls = refreshControls;

refreshControls();


// ===========================================================================
// INITIAL REAL DATE
// ===========================================================================

seedDate(
  CFG.defaultDate
);


// ---------------------------------------------------------------------------
// CAMERA
// ---------------------------------------------------------------------------

camT.set(
  0,
  0,
  0
);

camA.theta =
  0.72;

camA.phi =
  1.02;

camA.dist =
  510;

updCam();


// ===========================================================================
// ANIMATION / PHYSICS LOOP
// ===========================================================================

function frame(
  now
) {

  if (
    !state.alive
  )
    return;


  let realDt =

    Math.min(

      0.10,

      (
        now -
        state.lastReal
      )
      /
      1000
    );


  state.lastReal =
    now;


  if (
    !state.paused
  ) {

    state.accumulator +=

      realDt *

      state.daysPerSecond *

      DAY;


    let steps=0;

    const tBudget =
      performance.now();


    while (

      Math.abs(
        state.accumulator
      )
      >=
      CFG.dtSeconds

      &&

      steps <
      CFG.maxStepsPerFrame

      &&

      performance.now() - tBudget <
      CFG.frameBudgetMs

    ) {

      const dir =

        Math.sign(
          state.accumulator
        )
        ||
        1;


      physicsStep(

        dir *
        CFG.dtSeconds
      );


      state.simSeconds +=

        dir *
        CFG.dtSeconds;


      state.accumulator -=

        dir *
        CFG.dtSeconds;


      steps++;
    }


    // Behind schedule (slow machine or very high speed): drop the backlog,
    // otherwise the clock keeps racing long after speed() was lowered.
    if (
      Math.abs(state.accumulator) >=
      CFG.dtSeconds
    ) {

      state.accumulator = 0;
    }


    if (
      realDt > 0
    ) {

      const inst =
        steps *
        CFG.dtSeconds /
        DAY /
        realDt;

      state.achievedDaysPerSecond =
        state.achievedDaysPerSecond == null
          ? inst
          : state.achievedDaysPerSecond*0.9 + inst*0.1;
    }


    updateVisuals();

    sampleTrails();
  }


  // -----------------------------------------------------------------------
  // DIAGNOSTIC EVERY 2 s
  // -----------------------------------------------------------------------

  if (
    now -
    state.lastDiag
    >
    2000
  ) {

    state.lastDiag =
      now;


    if (
      !CFG.useGR
    ) {

      const E =
        totalNewtonianEnergy();


      state.energyDrift =

        (
          E -
          state.initialEnergy
        )

        /

        Math.abs(
          state.initialEnergy
        );
    }


    if (
      hud
    ) {

      const d =
        currentDate();


      hud.textContent =

        '☀ NASSCAD SOLAR SYSTEM  ·  ' +

        d
          .toISOString()
          .replace(
            'T',
            '  '
          )
          .replace(
            '.000Z',
            'Z'
          )

        +

        '\n'

        +

        (
          state.paused
            ? 'PAUSED'
            : 'RUN'
        )

        +

        '  × ' +

        state.daysPerSecond
          .toFixed(2)

        +

        ' day/s'

        +

        (
          !state.paused &&
          state.achievedDaysPerSecond != null &&
          state.achievedDaysPerSecond <
            0.95*Math.abs(state.daysPerSecond)

            ? ' (this machine: ' +
              state.achievedDaysPerSecond.toFixed(2) +
              ')'

            : ''
        )

        +

        '  ·  '

        +

        bodies.length

        +

        ' gravitating Objects'

        +

        '  ·  ΔE/E '

        +

        (
          CFG.useGR

            ? 'n/a (GR)'

            : state.energyDrift
                .toExponential(2)
        );
    }
  }


  // -----------------------------------------------------------------------
  // Properties panel refresh only 4 times/s, and only for an astro object.
  // -----------------------------------------------------------------------

  if (
    now -
    state.lastUI
    >
    250
  ) {

    state.lastUI =
      now;


    const active =

      selObjs.length

        ? selObjs[
            selObjs.length-1
          ]

        : null;


    if (

      active &&

      active.astro &&

      active.astro.engine ===
      'NASS_SOLAR_REAL'

    ) {

      updProps();
    }
  }


  requestAnimationFrame(
    frame
  );
}


requestAnimationFrame(
  frame
);


// ===========================================================================
// INFO
// ===========================================================================

scriptLog(
  '☀ Real-date Solar System ready'
);

scriptLog(
  'Date: '+
  state.date()
    .toISOString()
);

scriptLog(
  '23 gravitating bodies'
);

scriptLog(
  'Moon: Meeus lunar theory (ELP-2000/82, 60+60 terms), precessed to J2000'
);

scriptLog(
  'All planets and moons are registered in NASSCAD Objects'
);

scriptLog(
  'Physics: Newtonian N-body + Velocity Verlet' +
  (
    CFG.useJ2
      ? ' + J2 oblateness'
      : ''
  )
  +
  (
    CFG.useGR
      ? ' + solar 1PN'
      : ''
  )
);

scriptLog(
  'Commands:'
);

scriptLog(
  'NASS_SOLAR_REAL.setDate("2026-09-14T00:00:00Z")'
);

scriptLog(
  'NASS_SOLAR_REAL.now()'
);

scriptLog(
  'NASS_SOLAR_REAL.speed(1)'
);

scriptLog(
  'NASS_SOLAR_REAL.pause()'
);

scriptLog(
  'NASS_SOLAR_REAL.resume()'
);

scriptLog(
  'NASS_SOLAR_REAL.follow("Jupiter")'
);

scriptLog(
  'NASS_SOLAR_REAL.follow("Earth")'
);

scriptLog(
  'NASS_SOLAR_REAL.follow("Titan")'
);

scriptLog(
  'NASS_SOLAR_REAL.follow(null)'
);

scriptLog(
  'NASS_SOLAR_REAL.status()'
);

scriptLog(
  'NASS_SOLAR_REAL.destroy()'
);


return NASS_SOLAR_REAL.status();