export const TAB_META = [
  {
    id: 'guard',
    label: 'Guard Log',
    path: 'C:\\ProgramData\\control-deck\\guard.log',
  },
  {
    id: 'keeper',
    label: 'Keeper Log',
    path: 'C:\\ProgramData\\control-deck\\keeper.log',
  },
  {
    id: 'client',
    label: 'Client Log',
    path: '%APPDATA%\\control-deck\\logs\\client.log',
  },
  {
    id: 'blacklist',
    label: 'Blacklist',
    path: 'C:\\ProgramData\\control-deck\\blacklist.db',
  },
];

export const seedSnapshot = {
  connected: true,
  publicBlock: '2a09:bac5:3a1c:25c3::/64',
  publicHost: '2a09:bac5:3a1c:25c3:3c3:b',
  adapterIp: '2606:4700:110:8c2d:41ba:a270::',
  edge: '2606:4700::6812:b42',
  edgePolicy: 'auto',
  hops: 15,
  projects: 18,
  chats: 76,
  blacklisted: 12,
  lastHop: '15:24:54',
};

export const seedToggles = [
  {
    id: 'warpKeeper',
    title: 'WARP Keeper',
    subtitle: 'Enforces TUN mode & hosts Desktop proxy (127.0.0.1:41987)',
    enabled: true,
    tab: 'keeper',
  },
  {
    id: 'zenGuard',
    title: 'Zen Guard',
    subtitle: 'Auto-detects QuotaExceeded in client.log & rotates /64',
    enabled: true,
    tab: 'guard',
  },
  {
    id: 'desktopProxy',
    title: 'Desktop App Proxy',
    subtitle: 'Wires Client.exe daemon via service.json',
    enabled: true,
    tag: 'Wired :41987',
    tab: 'keeper',
  },
  {
    id: 'firewall',
    title: 'Firewall Kill-Switch',
    subtitle: 'OS-level rule blocking direct non-WARP CU egress (UAC)',
    enabled: false,
    tab: 'guard',
  },
  {
    id: 'strictHosts',
    title: 'Strict All-Hosts WARP',
    subtitle: 'Fail-closed for non-allowlisted domains inside proxy too',
    enabled: false,
    tab: 'guard',
  },
  {
    id: 'logonAutoStart',
    title: 'Logon Auto-Start',
    subtitle: 'Windows Scheduled Tasks for Keeper & Guard',
    enabled: true,
    tag: 'Enabled',
    tab: 'keeper',
  },
];

export const seedLogs = {
  guard: [
    {
      id: 'g-01',
      time: '11-13 17:30:45',
      level: 'success',
      text: 'rotated #13: 2a09:bac5:3a1b:25c3::3c4:3 -> 2a09:bac5:3a1a:101e::19b:25 /64',
    },
    {
      id: 'g-02',
      time: '11-13 17:30:47',
      level: 'info',
      text: 'edge pinned: 2606:4700::6810:5d2 · socket bind verified',
    },
    {
      id: 'g-03',
      time: '11-13 18:36:07',
      level: 'success',
      text: 'rotated #14: 2a09:bac5:3a1a:101e::19b:25 -> 2a09:bac5:3a1e:1d05::2e4:8d /64',
    },
    {
      id: 'g-04',
      time: '11-13 18:36:09',
      level: 'info',
      text: 'fail-closed socket rebound · no direct egress observed',
    },
    {
      id: 'g-05',
      time: '11-14 08:11:52',
      level: 'info',
      text: 'zen-guard up (poll 10s, cooldown 75s)',
    },
    {
      id: 'g-06',
      time: '11-14 08:11:54',
      level: 'success',
      text: 'guard preflight green · 3/3 Cloudflare edge probes reachable',
    },
    {
      id: 'g-07',
      time: '11-14 09:42:21',
      level: 'warn',
      text: 'QuotaExceeded in client.log · 429 response ×3',
    },
    {
      id: 'g-08',
      time: '11-14 09:42:23',
      level: 'info',
      text: 'preflight complete · requesting fresh /64 from WARP',
    },
    {
      id: 'g-09',
      time: '11-14 09:42:25',
      level: 'success',
      text: 'socket hand-off clean · old /64 moved to blacklist',
    },
    {
      id: 'g-10',
      time: '11-14 15:24:52',
      level: 'warn',
      text: 'quota threshold reached · guard requesting a new /64',
    },
    {
      id: 'g-11',
      time: '11-14 15:24:54',
      level: 'success',
      text: 'rotated #15: 2a09:bac5:3a1e:1d05::2e4:8d -> 2a09:bac5:3a1c:25c3:3c3:b /64',
    },
    {
      id: 'g-12',
      time: '11-14 15:24:55',
      level: 'success',
      text: 'edge pinned: 2606:4700::6812:b42 · AAAA handshake ok',
    },
    {
      id: 'g-13',
      time: '11-14 15:24:56',
      level: 'info',
      text: 'old /64 added to blacklist · 12 entries retained',
    },
    {
      id: 'g-14',
      time: '11-14 15:24:58',
      level: 'info',
      text: 'guard resumed · cooldown 75s · next poll in 10s',
    },
  ],
  keeper: [
    {
      id: 'k-01',
      time: '11-14 08:11:41',
      level: 'info',
      text: 'keeper start requested · service account LOCAL SYSTEM',
    },
    {
      id: 'k-02',
      time: '11-14 08:11:43',
      level: 'success',
      text: 'TUN mode enforced · WARP adapter is up',
    },
    {
      id: 'k-03',
      time: '11-14 08:11:44',
      level: 'success',
      text: 'WARP handshake complete · adapter 2606:4700:110:8c2d:41ba:a270::',
    },
    {
      id: 'k-04',
      time: '11-14 08:11:45',
      level: 'info',
      text: 'Desktop proxy listening 127.0.0.1:41987 · loopback only',
    },
    {
      id: 'k-05',
      time: '11-14 08:11:46',
      level: 'success',
      text: 'service.json wiring verified · Client.exe daemon attached',
    },
    {
      id: 'k-06',
      time: '11-14 08:11:48',
      level: 'info',
      text: 'pinned edge accepted · 2606:4700::6812:b42',
    },
    {
      id: 'k-07',
      time: '11-14 09:42:30',
      level: 'info',
      text: 'warp-cli registration refreshed · UDP hold 2,048 sockets',
    },
    {
      id: 'k-08',
      time: '11-14 12:05:11',
      level: 'info',
      text: 'keeper heartbeat ok · rtt 21ms · zero direct egress',
    },
    {
      id: 'k-09',
      time: '11-14 15:24:54',
      level: 'success',
      text: 'socket pool rebound to new /64 · fail-closed lane intact',
    },
    {
      id: 'k-10',
      time: '11-14 15:24:59',
      level: 'info',
      text: 'desktop proxy healthy · 127.0.0.1:41987',
    },
  ],
  client: [
    {
      id: 'o-01',
      time: '11-14 08:13:02',
      level: 'info',
      text: 'desktop session restored · 18 projects indexed',
    },
    {
      id: 'o-02',
      time: '11-14 08:13:03',
      level: 'success',
      text: 'daemon attached via 127.0.0.1:41987',
    },
    {
      id: 'o-03',
      time: '11-14 08:13:04',
      level: 'info',
      text: 'chat history loaded · 76 conversations',
    },
    {
      id: 'o-04',
      time: '11-14 08:13:05',
      level: 'success',
      text: 'daily quota guard armed · local usage receipts enabled',
    },
    {
      id: 'o-05',
      time: '11-14 09:12:18',
      level: 'info',
      text: 'chat completion stream healthy · 41 tok/s',
    },
    {
      id: 'o-06',
      time: '11-14 09:42:19',
      level: 'warn',
      text: 'upstream returned 429 · QuotaExceeded surfaced to guard',
    },
    {
      id: 'o-07',
      time: '11-14 09:42:33',
      level: 'success',
      text: 'retry routed through rotated /64 · stream resumed',
    },
    {
      id: 'o-08',
      time: '11-14 15:24:50',
      level: 'warn',
      text: 'quota cooldown observed · pausing request queue',
    },
    {
      id: 'o-09',
      time: '11-14 15:25:04',
      level: 'success',
      text: 'queue resumed · 6 pending chats flushed',
    },
    {
      id: 'o-10',
      time: '11-14 15:25:08',
      level: 'info',
      text: 'waiting for operator · local daemon healthy',
    },
  ],
  blacklist: [
    {
      id: 'b-01',
      time: '11-13 17:30:45',
      level: 'warn',
      text: '2a09:bac5:3a1b:25c3::/64 · blocked · quota 429 ×3',
    },
    {
      id: 'b-02',
      time: '11-13 18:36:07',
      level: 'warn',
      text: '2a09:bac5:3a1a:101e::/64 · blocked · quota 429 ×3',
    },
    {
      id: 'b-03',
      time: '11-14 08:03:10',
      level: 'warn',
      text: '2a09:bac5:3a2f:9c14::/64 · blocked · quota 429 ×3',
    },
    {
      id: 'b-04',
      time: '11-14 08:04:22',
      level: 'warn',
      text: '2a09:bac5:3a31:02d8::/64 · blocked · quota 429 ×3',
    },
    {
      id: 'b-05',
      time: '11-14 08:07:55',
      level: 'warn',
      text: '2a09:bac5:3a25:5ef1::/64 · blocked · quota 429 ×3',
    },
    {
      id: 'b-06',
      time: '11-14 08:18:40',
      level: 'warn',
      text: '2a09:bac5:3a0d:7a3c::/64 · blocked · quota 429 ×3',
    },
    {
      id: 'b-07',
      time: '11-14 08:37:14',
      level: 'warn',
      text: '2a09:bac5:3a1d:be72::/64 · blocked · quota 429 ×3',
    },
    {
      id: 'b-08',
      time: '11-14 09:42:21',
      level: 'warn',
      text: '2a09:bac5:3a44:13e9::/64 · blocked · quota 429 ×3',
    },
    {
      id: 'b-09',
      time: '11-14 10:16:08',
      level: 'warn',
      text: '2a09:bac5:3a12:c8f4::/64 · blocked · quota 429 ×3',
    },
    {
      id: 'b-10',
      time: '11-14 11:54:37',
      level: 'warn',
      text: '2a09:bac5:3a39:6d2a::/64 · blocked · quota 429 ×3',
    },
    {
      id: 'b-11',
      time: '11-14 13:31:12',
      level: 'warn',
      text: '2a09:bac5:3a07:f512::/64 · blocked · quota 429 ×3',
    },
    {
      id: 'b-12',
      time: '11-14 15:24:54',
      level: 'warn',
      text: '2a09:bac5:3a1e:1d05::/64 · blocked · quota 429 ×3',
    },
  ],
};

export const ROTATION_POOL = {
  blocks: [
    '2a09:bac5:3a1f:7e21::',
    '2a09:bac5:3a2c:91b4::',
    '2a09:bac5:3a30:44de::',
    '2a09:bac5:3a11:c7a2::',
    '2a09:bac5:3a4d:0b18::',
    '2a09:bac5:3a28:f3c1::',
    '2a09:bac5:3a35:8a6d::',
    '2a09:bac5:3a42:d9e0::',
    '2a09:bac5:3a29:0f5b::',
    '2a09:bac5:3a16:62c8::',
  ],
  hostSuffixes: [
    '7fa:12',
    '2ad:51',
    '5e4:8d',
    '3c3:b',
    '17b:26',
    '6f2:a9',
    '4d8:71',
    '291:3e',
    '8c4:5f',
    '31e:c2',
  ],
  adapters: [
    '2606:4700:110:8a1f:7c3a:82ab::',
    '2606:4700:110:84f1:6a2f:9e31::',
    '2606:4700:110:812c:4d9b:f20e::',
    '2606:4700:110:8f3d:29ac:1e77::',
    '2606:4700:110:867e:82b4:48df::',
    '2606:4700:110:83a2:61ce:b04d::',
  ],
  edges: [
    '2606:4700::6810:1f22',
    '2606:4700::6811:2f11',
    '2606:4700::6812:1ba',
    '2606:4700::6813:a1c',
    '2606:4700::6810:5d2',
    '2606:4700::6812:b42',
  ],
};

// Keep the pinned-edge select in lockstep with the rotation pool. The active
// edge leads, then every other pool edge follows exactly once.
const pinnedEdgeValues = [
  seedSnapshot.edge,
  ...ROTATION_POOL.edges.filter((edge) => edge !== seedSnapshot.edge),
];

export const EDGE_OPTIONS = [
  { value: 'auto', label: 'Auto-Random Edge' },
  ...pinnedEdgeValues.map((edge) => ({ value: edge, label: edge })),
];

export function buildNextRotation(index, edgePolicy, currentEdge) {
  const block = ROTATION_POOL.blocks[index % ROTATION_POOL.blocks.length];
  const suffix = ROTATION_POOL.hostSuffixes[index % ROTATION_POOL.hostSuffixes.length];
  const adapter = ROTATION_POOL.adapters[index % ROTATION_POOL.adapters.length];
  const edge =
    edgePolicy === 'auto'
      ? ROTATION_POOL.edges[index % ROTATION_POOL.edges.length]
      : currentEdge;

  return {
    block,
    publicBlock: `${block}/64`,
    host: `${block}${suffix}`,
    adapter,
    edge,
  };
}

export function nextEdgeAfter(currentEdge) {
  const options = ROTATION_POOL.edges.filter((edge) => edge !== currentEdge);
  return options[Math.floor(Math.random() * options.length)] ?? ROTATION_POOL.edges[0];
}

export function stampNow(date = new Date()) {
  const two = (value) => String(value).padStart(2, '0');
  return `${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(
    date.getMinutes(),
  )}:${two(date.getSeconds())}`;
}

export function clockNow(date = new Date()) {
  const two = (value) => String(value).padStart(2, '0');
  return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
}
