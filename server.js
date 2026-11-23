'use strict';
/* Open Estate - online Monopoly-style game server.
 * - Authoritative rules on the server
 * - All randomness (dice, card shuffles) from crypto.randomInt, logged publicly
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;

/* ---------------- Board ---------------- */
const C = (name, group, price) => ({ type: 'city', name, group, price });
const BOARD = [
  { type: 'go', name: 'GO' },
  C('Cairo', 'Egypt', 60),
  { type: 'chest', name: 'Community Chest' },
  C('Alexandria', 'Egypt', 60),
  { type: 'tax', name: 'Income Tax', amount: 200 },
  { type: 'air', name: 'Dubai Intl', price: 200 },
  C('Casablanca', 'Morocco', 100),
  { type: 'chance', name: 'Chance' },
  C('Marrakech', 'Morocco', 100),
  C('Rabat', 'Morocco', 120),
  { type: 'jail', name: 'Jail / Just Visiting' },
  C('Riyadh', 'Saudi Arabia', 140),
  { type: 'util', name: 'Electric Co.', price: 150, icon: 'bolt' },
  C('Jeddah', 'Saudi Arabia', 140),
  C('Mecca', 'Saudi Arabia', 160),
  { type: 'air', name: 'Heathrow', price: 200 },
  C('Istanbul', 'Turkey', 180),
  { type: 'chest', name: 'Community Chest' },
  C('Ankara', 'Turkey', 180),
  C('Izmir', 'Turkey', 200),
  { type: 'free', name: 'Free Parking' },
  C('Madrid', 'Spain', 220),
  { type: 'chance', name: 'Chance' },
  C('Barcelona', 'Spain', 220),
  C('Seville', 'Spain', 240),
  { type: 'air', name: 'Charles de Gaulle', price: 200 },
  C('Rome', 'Italy', 260),
  C('Milan', 'Italy', 260),
  { type: 'util', name: 'Water Works', price: 150, icon: 'drop' },
  C('Venice', 'Italy', 280),
  { type: 'gotojail', name: 'Go To Jail' },
  C('Paris', 'France', 300),
  C('Lyon', 'France', 300),
  { type: 'chest', name: 'Community Chest' },
  C('Marseille', 'France', 320),
  { type: 'air', name: 'JFK', price: 200 },
  { type: 'chance', name: 'Chance' },
  C('London', 'UK', 350),
  { type: 'tax', name: 'Luxury Tax', amount: 100 },
  C('Manchester', 'UK', 400),
];
const GROUP_IDX = {};
const AIR = [];
const UTIL = [];
BOARD.forEach((sq, i) => {
  if (sq.type === 'city') {
    (GROUP_IDX[sq.group] = GROUP_IDX[sq.group] || []).push(i);
    const base = Math.max(2, Math.round(sq.price * 0.04));
    sq.rents = [base, base * 5, base * 15, base * 45, base * 80, base * 125];
    sq.houseCost = i < 10 ? 50 : i < 20 ? 100 : i < 30 ? 150 : 200;
  }
  if (sq.type === 'air') AIR.push(i);
  if (sq.type === 'util') UTIL.push(i);
});

const CHANCE = [
  { t: 'Advance to GO. Collect 200.', a: 'go' },
  { t: 'Take a trip to Mecca. Pass GO, collect 200.', a: 'move', to: 14 },
  { t: 'Advance to London.', a: 'move', to: 37 },
  { t: 'Bank pays you a dividend of 50.', a: 'money', v: 50 },
  { t: 'Go back 3 spaces.', a: 'back', v: 3 },
  { t: 'Go directly to Jail.', a: 'jail' },
  { t: 'Speeding fine. Pay 15.', a: 'money', v: -15 },
  { t: 'Your building loan matures. Collect 150.', a: 'money', v: 150 },
  { t: 'You are elected chairman. Pay each player 50.', a: 'each', v: -50 },
];
const CHEST = [
  { t: 'Bank error in your favour. Collect 200.', a: 'money', v: 200 },
  { t: "Doctor's fee. Pay 50.", a: 'money', v: -50 },
  { t: 'You inherit 100.', a: 'money', v: 100 },
  { t: 'Go directly to Jail.', a: 'jail' },
  { t: "It's your birthday. Collect 10 from each player.", a: 'each', v: 10 },
  { t: 'Tax refund. Collect 20.', a: 'money', v: 20 },
  { t: 'School fees. Pay 50.', a: 'money', v: -50 },
  { t: 'Advance to GO. Collect 200.', a: 'go' },
  { t: 'Hospital bill. Pay 100.', a: 'money', v: -100 },
];

const COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f1c40f', '#9b59b6', '#e67e22', '#1abc9c', '#ecf0f1'];
const MAX_PLAYERS = 8;
const START_MONEY = 1500;

/* ---------------- Helpers ---------------- */
const rooms = new Map();
const rnd = (n) => crypto.randomInt(0, n);
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = rnd(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
function newCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let s;
  do {
    s = '';
    for (let i = 0; i < 4; i++) s += A[rnd(A.length)];
  } while (rooms.has(s));
  return s;
}
const byId = (room, id) => room.players.find((p) => p.id === id);
const clean = (s, n) => String(s || '').replace(/[<>]/g, '').trim().slice(0, n);

function log(room, msg) {
  const g = room.g;
  g.log.push(msg);
  if (g.log.length > 200) g.log.shift();
}
function groupOf(i) { return GROUP_IDX[BOARD[i].group]; }
function hasSet(room, id, i) { return groupOf(i).every((j) => room.g.props[j].owner === id); }
function ownedBy(room, id) {
  const out = [];
  room.g.props.forEach((p, i) => { if (p && p.owner === id) out.push(i); });
  return out;
}
function liquid(room, p) {
  let t = 0;
  for (const i of ownedBy(room, p.id)) {
    const sq = BOARD[i];
    const pr = room.g.props[i];
    if (!pr.mort) t += sq.price / 2;
    if (sq.type === 'city') t += (pr.houses * sq.houseCost) / 2;
  }
  return Math.floor(t);
}

/* ---------------- Game core ---------------- */
function initGame(room) {
  const g = {
    props: BOARD.map((sq) => (sq.price ? { owner: null, houses: 0, mort: false } : null)),
    turn: null, phase: 'roll', dice: [0, 0], doubles: 0, lastDoubles: false,
    pending: null, trade: null, log: [], rolls: [], winner: null, tradeSeq: 0,
    decks: { chance: { order: shuffle(CHANCE.map((_, i) => i)), i: 0 }, chest: { order: shuffle(CHEST.map((_, i) => i)), i: 0 } },
  };
  room.g = g;
  shuffle(room.players);
  room.players.forEach((p) => Object.assign(p, { money: START_MONEY, pos: 0, inJail: false, jailTurns: 0, bankrupt: false, debtTo: null }));
  g.turn = room.players[0].id;
  room.started = true;
  g.rolls.push({ kind: 'shuffle', text: 'Turn order and both card decks shuffled with crypto.randomInt (Fisher-Yates)' });
  log(room, `Game started. ${room.players[0].name} goes first.`);
}

function sendToJail(room, p) {
  p.pos = 10; p.inJail = true; p.jailTurns = 0;
  room.g.doubles = 0; room.g.lastDoubles = false;
  log(room, `${p.name} goes to Jail`);
}

function charge(room, p, amt, to) {
  if (amt <= 0 || p.bankrupt) return;
  p.money -= amt;
  if (to) to.money += amt;
  if (p.money < 0) {
    p.debtTo = to ? to.id : null;
    if (p.money + liquid(room, p) < 0) goBankrupt(room, p);
  }
}

function goBankrupt(room, p) {
  const g = room.g;
  if (p.bankrupt) return;
  const creditor = p.debtTo != null ? byId(room, p.debtTo) : null;
  const had = ownedBy(room, p.id);
  for (const i of had) {
    const pr = g.props[i];
    pr.houses = 0;
    if (creditor && !creditor.bankrupt) pr.owner = creditor.id;
    else { pr.owner = null; pr.mort = false; }
  }
  if (creditor && !creditor.bankrupt && p.money > 0) creditor.money += p.money;
  p.money = 0; p.bankrupt = true; p.inJail = false;
  log(room, `${p.name} is bankrupt${creditor ? ` - assets go to ${creditor.name}` : ' - assets return to the bank'}`);
  if (g.trade && (g.trade.from === p.id || g.trade.to === p.id)) g.trade = null;
  if (g.pending != null && g.turn === p.id) g.pending = null;
  const alive = room.players.filter((x) => !x.bankrupt);
  if (alive.length <= 1) {
    g.winner = alive[0] ? alive[0].id : null; g.phase = 'over';
    if (alive[0]) log(room, `${alive[0].name} wins the game!`);
  } else if (g.turn === p.id) nextTurn(room);
}

function nextTurn(room) {
  const g = room.g;
  const alive = room.players.filter((p) => !p.bankrupt);
  if (alive.length <= 1) {
    g.winner = alive[0] ? alive[0].id : null; g.phase = 'over'; return;
  }
  let i = room.players.findIndex((p) => p.id === g.turn);
  do { i = (i + 1) % room.players.length; } while (room.players[i].bankrupt);
  g.turn = room.players[i].id;
  g.phase = 'roll'; g.doubles = 0; g.lastDoubles = false; g.pending = null;
}

function rentFor(room, i, total) {
  const sq = BOARD[i]; const pr = room.g.props[i]; const owner = pr.owner;
  if (sq.type === 'city') {
    if (pr.houses > 0) return sq.rents[pr.houses];
    return sq.rents[0] * (hasSet(room, owner, i) ? 2 : 1);
  }
  if (sq.type === 'air') {
    const n = AIR.filter((j) => room.g.props[j].owner === owner).length;
    return 25 * Math.pow(2, n - 1);
  }
  const n = UTIL.filter((j) => room.g.props[j].owner === owner).length;
  return total * (n === 2 ? 10 : 4);
}

function moveTo(room, p, dest, collect) {
  if (collect && dest < p.pos) { p.money += 200; log(room, `${p.name} passes GO and collects 200`); }
  p.pos = dest;
  land(room, p);
}

function drawCard(room, p, kind) {
  const g = room.g;
  const deck = g.decks[kind]; const list = kind === 'chance' ? CHANCE : CHEST;
  const card = list[deck.order[deck.i % deck.order.length]]; deck.i++;
  log(room, `${p.name} draws ${kind === 'chance' ? 'Chance' : 'Community Chest'}: ${card.t}`);
  g.rolls.push({ kind: 'card', player: p.name, deck: kind, text: card.t });
  g.lastCard = { kind, text: card.t, player: p.id };
  switch (card.a) {
    case 'go': moveTo(room, p, 0, true); break;
    case 'move': moveTo(room, p, card.to, true); break;
    case 'back': moveTo(room, p, (p.pos - card.v + 40) % 40, false); break;
    case 'jail': sendToJail(room, p); break;
    case 'money':
      if (card.v > 0) p.money += card.v; else charge(room, p, -card.v, null);
      break;
    case 'each':
      for (const q of room.players) {
        if (q.id === p.id || q.bankrupt || p.bankrupt) continue;
        if (card.v < 0) charge(room, p, -card.v, q); else charge(room, q, card.v, p);
      }
      break;
  }
}

function land(room, p) {
  const g = room.g; const sq = BOARD[p.pos];
  switch (sq.type) {
    case 'gotojail': sendToJail(room, p); break;
    case 'tax': log(room, `${p.name} pays ${sq.amount} (${sq.name})`); charge(room, p, sq.amount, null); break;
    case 'chance': case 'chest': drawCard(room, p, sq.type); break;
    case 'city': case 'air': case 'util': {
      const pr = g.props[p.pos];
      if (pr.owner === null) { g.phase = 'buy'; g.pending = p.pos; log(room, `${p.name} lands on ${sq.name} (unowned, ${sq.price})`); }
      else if (pr.owner !== p.id) {
        const owner = byId(room, pr.owner);
        if (pr.mort) log(room, `${p.name} lands on ${sq.name} (mortgaged, no rent)`);
        else {
          const rent = rentFor(room, p.pos, g.dice[0] + g.dice[1]);
          log(room, `${p.name} lands on ${sq.name} and pays ${rent} rent to ${owner.name}`);
          charge(room, p, rent, owner);
        }
      } else log(room, `${p.name} lands on their own ${sq.name}`);
      break;
    }
    default: log(room, `${p.name} lands on ${sq.name}`);
  }
}

function finish(room, p) {
  const g = room.g;
  if (p.bankrupt || g.winner || g.phase === 'buy') return;
  if (g.turn !== p.id) return;
  g.phase = g.lastDoubles && !p.inJail ? 'roll' : 'post';
  if (g.phase === 'roll') log(room, `${p.name} rolled doubles and rolls again`);
}

function rollDice(room, p) {
  const a = rnd(6) + 1; const b = rnd(6) + 1;
  room.g.rolls.push({ kind: 'dice', n: room.g.rolls.filter((r) => r.kind === 'dice').length + 1, player: p.name, a, b });
  if (room.g.rolls.length > 3000) room.g.rolls.shift();
  return [a, b];
}

/* ---------------- Actions ---------------- */
function validateTrade(room, t) {
  const g = room.g;
  const a = byId(room, t.from); const b = byId(room, t.to);
  if (!a || !b || a.bankrupt || b.bankrupt || a === b) return 'Invalid players';
  const side = (props, owner) => {
    for (const i of props) {
      const pr = g.props[i];
      if (!pr || pr.owner !== owner.id) return `${owner.name} does not own ${BOARD[i] ? BOARD[i].name : '?'}`;
      if (BOARD[i].type === 'city' && groupOf(i).some((j) => g.props[j].houses > 0)) return 'Sell all houses in the group before trading it';
    }
    return null;
  };
  const e = side(t.give.props, a) || side(t.get.props, b);
  if (e) return e;
  if (a.money < t.give.money) return `${a.name} cannot afford that`;
  if (b.money < t.get.money) return `${b.name} cannot afford that`;
  if (!t.give.money && !t.get.money && !t.give.props.length && !t.get.props.length) return 'Empty trade';
  return null;
}
const ints = (arr) => [...new Set((Array.isArray(arr) ? arr : []).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < 40))];
const amt = (n) => { n = Math.floor(Number(n)); return Number.isFinite(n) && n > 0 ? n : 0; };

function act(room, me, m, reply) {
  const g = room.g;
  if (m.t === 'chat') {
    const text = clean(m.text, 200);
    if (text) log(room, `\u{1F4AC} ${me.name}: ${text}`);
    return;
  }
  if (!g || g.winner || me.bankrupt) return;
  const myTurn = g.turn === me.id;
  switch (m.t) {
    case 'roll': {
      if (!myTurn || g.phase !== 'roll') return;
      const [a, b] = rollDice(room, me); g.dice = [a, b];
      const dbl = a === b;
      if (me.inJail) {
        if (dbl) {
          me.inJail = false; me.jailTurns = 0; g.lastDoubles = false;
          log(room, `${me.name} rolled ${a}+${b} (doubles) and leaves Jail`);
          moveTo(room, me, (me.pos + a + b) % 40, true);
        } else {
          me.jailTurns++; g.lastDoubles = false;
          if (me.jailTurns >= 3) {
            log(room, `${me.name} rolled ${a}+${b}, third failed attempt: pays 50 and moves`);
            me.inJail = false; me.jailTurns = 0;
            charge(room, me, 50, null);
            if (me.bankrupt) return;
            moveTo(room, me, (me.pos + a + b) % 40, true);
          } else {
            log(room, `${me.name} rolled ${a}+${b} and stays in Jail`);
            g.phase = 'post'; return;
          }
        }
      } else {
        if (dbl) {
          g.doubles++;
          if (g.doubles >= 3) {
            log(room, `${me.name} rolled ${a}+${b}: third doubles in a row, straight to Jail`);
            sendToJail(room, me); g.phase = 'post'; return;
          }
          g.lastDoubles = true;
        } else { g.doubles = 0; g.lastDoubles = false; }
        log(room, `${me.name} rolled ${a}+${b}`);
        moveTo(room, me, (me.pos + a + b) % 40, true);
      }
      finish(room, me);
      break;
    }
    case 'payjail': {
      if (!myTurn || g.phase !== 'roll' || !me.inJail || me.money < 50) return;
      me.money -= 50; me.inJail = false; me.jailTurns = 0;
      log(room, `${me.name} pays 50 to leave Jail`);
      break;
    }
    case 'buy': case 'decline': {
      if (!myTurn || g.phase !== 'buy' || g.pending == null) return;
      const i = g.pending; const sq = BOARD[i];
      if (m.t === 'buy') {
        if (me.money < sq.price) return reply('Not enough money');
        me.money -= sq.price; g.props[i].owner = me.id;
        log(room, `${me.name} buys ${sq.name} for ${sq.price}`);
      } else log(room, `${me.name} passes on ${sq.name}`);
      g.pending = null; g.phase = 'post';
      finish(room, me);
      break;
    }
    case 'end': {
      if (!myTurn || g.phase !== 'post') return;
      if (me.money < 0) return reply('Raise cash or declare bankruptcy first');
      nextTurn(room);
      break;
    }
    case 'bankrupt': {
      if (me.money >= 0 && !m.force) return reply('You are not in debt');
      goBankrupt(room, me);
      break;
    }
    case 'build': case 'sell': {
      const i = Number(m.idx); const sq = BOARD[i];
      if (!sq || sq.type !== 'city') return;
      const pr = g.props[i];
      if (pr.owner !== me.id) return;
      const grp = groupOf(i);
      if (m.t === 'build') {
        if (!myTurn) return reply('You can only build on your own turn');
        if (!hasSet(room, me.id, i)) return reply('You need the whole country first');
        if (grp.some((j) => g.props[j].mort)) return reply('Unmortgage the whole country first');
        if (pr.houses >= 5) return reply('Already a hotel');
        if (pr.houses > Math.min(...grp.map((j) => g.props[j].houses))) return reply('Build evenly across the country');
        if (me.money < sq.houseCost) return reply('Not enough money');
        me.money -= sq.houseCost; pr.houses++;
        log(room, `${me.name} builds on ${sq.name} (${pr.houses === 5 ? 'hotel' : pr.houses + ' house' + (pr.houses > 1 ? 's' : '')})`);
      } else {
        if (pr.houses <= 0) return;
        if (pr.houses < Math.max(...grp.map((j) => g.props[j].houses))) return reply('Sell evenly across the country');
        pr.houses--; me.money += sq.houseCost / 2;
        log(room, `${me.name} sells a house on ${sq.name}`);
      }
      break;
    }
    case 'mortgage': case 'unmortgage': {
      const i = Number(m.idx); const sq = BOARD[i];
      if (!sq || !sq.price) return;
      const pr = g.props[i];
      if (pr.owner !== me.id) return;
      if (m.t === 'mortgage') {
        if (pr.mort) return;
        if (sq.type === 'city' && groupOf(i).some((j) => g.props[j].houses > 0)) return reply('Sell the houses in this country first');
        pr.mort = true; me.money += sq.price / 2;
        log(room, `${me.name} mortgages ${sq.name} for ${sq.price / 2}`);
      } else {
        const cost = Math.ceil((sq.price / 2) * 1.1);
        if (!pr.mort) return;
        if (me.money < cost) return reply(`Unmortgaging costs ${cost}`);
        pr.mort = false; me.money -= cost;
        log(room, `${me.name} unmortgages ${sq.name} for ${cost}`);
      }
      break;
    }
    case 'trade': {
      if (g.trade) return reply('Another trade is already open');
      const to = byId(room, Number(m.to));
      if (!to) return;
      const t = {
        id: ++g.tradeSeq, from: me.id, to: to.id,
        give: { money: amt(m.giveMoney), props: ints(m.giveProps) },
        get: { money: amt(m.getMoney), props: ints(m.getProps) },
      };
      const e = validateTrade(room, t);
      if (e) return reply(e);
      g.trade = t;
      log(room, `${me.name} proposes a trade to ${to.name}`);
      break;
    }
    case 'tradeCancel': {
      if (!g.trade || g.trade.from !== me.id) return;
      g.trade = null; log(room, `${me.name} cancels the trade`);
      break;
    }
    case 'tradeAnswer': {
      const t = g.trade;
      if (!t || t.to !== me.id) return;
      if (!m.accept) { g.trade = null; log(room, `${me.name} declines the trade`); break; }
      const e = validateTrade(room, t);
      if (e) { g.trade = null; return reply('Trade no longer valid: ' + e); }
      const a = byId(room, t.from); const b = byId(room, t.to);
      a.money += t.get.money - t.give.money; b.money += t.give.money - t.get.money;
      t.give.props.forEach((i) => { g.props[i].owner = b.id; });
      t.get.props.forEach((i) => { g.props[i].owner = a.id; });
      g.trade = null;
      log(room, `Trade done between ${a.name} and ${b.name}`);
      break;
    }
  }
}

/* ---------------- Networking ---------------- */
function viewFor(room) {
  const g = room.g;
  return {
    code: room.code, started: room.started, host: room.hostId,
    players: room.players.map((p) => ({
      id: p.id, name: p.name, color: p.color, money: p.money, pos: p.pos,
      inJail: p.inJail, bankrupt: p.bankrupt, online: !!(p.ws && p.ws.readyState === 1),
    })),
    g: g && {
      props: g.props, turn: g.turn, phase: g.phase, dice: g.dice, pending: g.pending,
      trade: g.trade, log: g.log.slice(-80), rolls: g.rolls.slice(-400), winner: g.winner,
      lastCard: g.lastCard || null,
      stats: (() => {
        const d = g.rolls.filter((r) => r.kind === 'dice');
        return { total: d.length, doubles: d.filter((r) => r.a === r.b).length };
      })(),
    },
  };
}
function broadcast(room) {
  const s = viewFor(room);
  for (const p of room.players) {
    if (p.ws && p.ws.readyState === 1) p.ws.send(JSON.stringify({ t: 'state', me: p.id, s }));
  }
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200); return res.end('ok'); }
  const file = path.join(__dirname, 'index.html');
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(500); return res.end('index.html missing'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.send(JSON.stringify({ t: 'board', board: BOARD }));
  let room = null; let me = null;
  const reply = (msg) => ws.send(JSON.stringify({ t: 'err', msg }));

  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.t !== 'string') return;

    if (m.t === 'create' || m.t === 'join') {
      const token = clean(m.token, 64); const name = clean(m.name, 16) || 'Player';
      if (!token) return;
      let r;
      if (m.t === 'create') {
        r = { code: newCode(), players: [], g: null, started: false, hostId: null, nextId: 1, touched: Date.now() };
        rooms.set(r.code, r);
      } else {
        r = rooms.get(clean(m.code, 8).toUpperCase());
        if (!r) { ws.send(JSON.stringify({ t: 'gone' })); return; }
      }
      let p = r.players.find((x) => x.token === token);
      if (p) { if (p.ws && p.ws !== ws) try { p.ws.close(); } catch {} p.ws = ws; }
      else {
        if (r.started) return reply('Game already started');
        if (r.players.length >= MAX_PLAYERS) return reply('Room is full');
        const used = r.players.map((x) => x.color);
        p = { id: r.nextId++, token, name, color: COLORS.find((c) => !used.includes(c)), ws, money: START_MONEY, pos: 0, inJail: false, jailTurns: 0, bankrupt: false, debtTo: null };
        r.players.push(p);
        if (r.hostId == null) r.hostId = p.id;
        if (r.started) log(r, `${p.name} joined`);
      }
      room = r; me = p; r.touched = Date.now();
      broadcast(r);
      return;
    }
    if (!room || !me) return;
    room.touched = Date.now();
    if (m.t === 'start') {
      if (room.started || me.id !== room.hostId) return;
      if (room.players.length < 2) return reply('Need at least 2 players');
      initGame(room); broadcast(room); return;
    }
    if (m.t === 'leave') {
      if (!room.started) {
        room.players = room.players.filter((p) => p !== me);
        if (room.hostId === me.id && room.players[0]) room.hostId = room.players[0].id;
        if (!room.players.length) rooms.delete(room.code);
        else broadcast(room);
      }
      ws.send(JSON.stringify({ t: 'gone' })); room = null; me = null; return;
    }
    if (!room.started) return;
    act(room, me, m, reply);
    broadcast(room);
  });

  ws.on('close', () => {
    if (!room || !me) return;
    if (me.ws === ws) me.ws = null;
    if (!room.started) {
      room.players = room.players.filter((p) => p !== me);
      if (room.hostId === me.id && room.players[0]) room.hostId = room.players[0].id;
      if (!room.players.length) { rooms.delete(room.code); return; }
    }
    broadcast(room);
  });
});

setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false; ws.ping();
  });
  const now = Date.now();
  for (const [c, r] of rooms) {
    const online = r.players.some((p) => p.ws && p.ws.readyState === 1);
    if (!online && now - r.touched > 6 * 3600 * 1000) rooms.delete(c);
  }
}, 30000);

server.listen(PORT, () => console.log('Open Estate listening on ' + PORT));
