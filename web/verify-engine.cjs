const E = require('./engine.cjs');
const { D, plain, S, ZERO } = E;
let pass = 0, fail = 0;
function eq(label, got, want) {
  const g = typeof got === 'bigint' ? plain(got) : String(got);
  const w = typeof want === 'bigint' ? plain(want) : String(want);
  if (g === w) { pass++; } else { fail++; console.log(`FAIL ${label}\n  got  ${g}\n  want ${w}`); }
}
function setup(cfg = {}) {
  E.state.config = Object.assign({ name:'T', currency:'USD', startingCash:'10000',
    commissionFlat:'0', commissionPct:'0', allowFractional:false, allowShort:false,
    allowNegativeCash:false, maxPositionPct:null }, cfg);
  E.state.unit = '$';
  E.state.players = [{id:'alice',name:'Alice',startingCash:'10000',joinedAt:'1'},
                     {id:'bob',name:'Bob',startingCash:'10000',joinedAt:'2'}];
  E.state.ledger = []; E.state.prices = {}; E.state.snapshots = [];
}
let seq = 0;
function trade(player, kind, symbol, shares, price, fee = '0') {
  E.state.ledger.push({ id:'e'+(++seq), seq, kind, player, at:'2026-01-01T00:00:00Z',
    symbol, shares:String(shares), price:String(price), commission:String(fee), amount:'0', note:'' });
}
function cashEntry(player, kind, amount) {
  E.state.ledger.push({ id:'e'+(++seq), seq, kind, player, at:'2026-01-01T00:00:00Z',
    symbol:null, shares:'0', price:'0', commission:'0', amount:String(amount), note:'' });
}

// --- decimal parsing
eq('parse 0.1', D('0.1'), 10000000n);
eq('parse -$1,234.50', D('-$1,234.50'), -123450000000n);
eq('mul exact', E.mul(D('1.5'), D('333.33')), D('499.995'));
eq('qCash half-up', E.qCash(D('2.345')), D('2.35'));
eq('qCash negative half-up', E.qCash(D('-2.345')), D('-2.35'));
eq('fmtMoney', E.fmtMoney(D('1234.5'), '$'), '$1,234.50');
eq('fmtSigned zero', E.fmtSigned(ZERO, '$'), '$0.00');
eq('fmtPct tiny loss', E.fmtPct(E.pctOf(D('-0.07'), D('100000'))), '0.00%');
eq('fmtPct', E.fmtPct(D('12.345')), '+12.35%');
eq('fmtShares trims', E.fmtShares(D('100.00000000')), '100');

// --- cost basis (mirrors tests/test_engine.py)
setup(); trade('alice','BUY','AAPL',10,100);
eq('buy cash', E.replay('alice').cash, D('9000'));
setup(); trade('alice','BUY','AAPL',10,100); trade('alice','BUY','AAPL',10,120);
eq('avg cost', E.qPrice(E.dvd(E.positionOf(E.replay('alice'),'AAPL').cost, E.positionOf(E.replay('alice'),'AAPL').shares)), D('110'));
setup(); trade('alice','BUY','AAPL',10,100); trade('alice','SELL','AAPL',4,150);
eq('partial sale realized', E.replay('alice').realized, D('200'));
eq('partial sale shares', E.positionOf(E.replay('alice'),'AAPL').shares, D('6'));
setup(); trade('alice','BUY','AAPL',5,100); trade('alice','SELL','AAPL',5,90);
eq('closed basis', E.positionOf(E.replay('alice'),'AAPL').cost, ZERO);
eq('closed realized', E.replay('alice').realized, D('-50'));
setup({allowShort:true}); trade('alice','BUY','AAPL',5,100); trade('alice','SELL','AAPL',8,120);
eq('cross zero realized', E.replay('alice').realized, D('100'));
eq('cross zero shares', E.positionOf(E.replay('alice'),'AAPL').shares, D('-3'));
eq('cross zero new basis', E.positionOf(E.replay('alice'),'AAPL').cost, D('-360'));
setup({allowShort:true}); trade('alice','SELL','AAPL',10,100); trade('alice','BUY','AAPL',10,80);
eq('cover short realized', E.replay('alice').realized, D('200'));
setup(); trade('alice','BUY','AAPL',10,100,'5');
eq('fee cash', E.replay('alice').cash, D('8995'));
eq('fee realized', E.replay('alice').realized, D('-5'));
eq('commission pct', (setup({commissionPct:'0.5'}), E.commissionOn(D('1000'))), D('5'));

// --- the reconciliation identity
setup({allowShort:true, allowFractional:true, commissionFlat:'1', commissionPct:'0.1'});
for (const [k,s,q,p] of [['BUY','AAPL','10.5','100'],['BUY','MSFT','3','410.25'],
     ['SELL','AAPL','4.25','133.33'],['SELL','TSLA','2','250'],['BUY','AAPL','1','90']]) {
  const fee = E.commissionOn(E.qCash(E.mul(D(q), D(p))));
  trade('alice',k,s,q,p, plain(fee));
}
cashEntry('alice','DEPOSIT','500');
E.state.prices = { AAPL:{symbol:'AAPL',price:'141.00'}, MSFT:{symbol:'MSFT',price:'399.10'},
                   TSLA:{symbol:'TSLA',price:'230.00'} };
{ const v = E.valuate(E.replay('alice'));
  eq('identity: pnl == realized + unrealized', v.pnl, E.qCash(v.pf.realized + v.unreal)); }

// --- rules
setup();
eq('overspend refused', /short/.test(E.checkTrade('alice','BUY','AAPL',D('200'),D('100'),ZERO)||''), 'true');
trade('alice','BUY','AAPL',5,100);
eq('oversell refused', /Short selling is off/.test(E.checkTrade('alice','SELL','AAPL',D('6'),D('100'),ZERO)||''), 'true');
setup();
eq('fractional refused', /Fractional/.test(E.checkTrade('alice','BUY','AAPL',D('1.5'),D('100'),ZERO)||''), 'true');
setup({allowFractional:true});
eq('fractional allowed', String(E.checkTrade('alice','BUY','AAPL',D('1.5'),D('100'),ZERO)), 'null');
setup({maxPositionPct:'30'}); trade('alice','BUY','AAPL',25,100);
eq('cap exceeded', /Position cap/.test(E.checkTrade('alice','BUY','AAPL',D('10'),D('100'),ZERO)||''), 'true');
setup({maxPositionPct:'50'}); trade('alice','BUY','MSFT',10,100);
E.state.prices = { MSFT:{symbol:'MSFT',price:'200'} };
eq('cap uses live marks', String(E.checkTrade('alice','BUY','AAPL',D('45'),D('100'),ZERO)), 'null');

// --- valuation & standings
setup(); trade('alice','BUY','AAPL',10,100); trade('bob','BUY','AAPL',20,100);
E.state.prices = { AAPL:{symbol:'AAPL',price:'150',prevClose:'140'} };
{ const b = E.standings();
  eq('ranked by equity', b.map(v=>v.pf.player.id).join(','), 'bob,alice');
  eq('equity', b[0].equity, D('11000'));
  eq('day change', b[0].day, D('200'));
  eq('return pct', E.fmtPct(b[0].ret), '+10.00%'); }
setup(); trade('alice','BUY','AAPL',10,100); E.state.prices = {};
{ const v = E.valuate(E.replay('alice'));
  eq('unpriced held at cost', v.equity, D('10000'));
  eq('unpriced flagged', v.unpriced.join(','), 'AAPL'); }
setup({allowShort:true}); trade('alice','SELL','AAPL',10,100);
E.state.prices = { AAPL:{symbol:'AAPL',price:'80'} };
eq('short gains as price falls', E.valuate(E.replay('alice')).unreal, D('200'));
setup(); trade('alice','BUY','AAPL',10,100);
{ const before = E.replay('alice'); trade('alice','SELL','AAPL',5,130);
  E.state.ledger.pop();
  const after = E.replay('alice');
  eq('undo restores cash', after.cash, before.cash);
  eq('undo restores realized', after.realized, before.realized); }
setup(); cashEntry('alice','DEPOSIT','5000');
{ const v = E.valuate(E.replay('alice'));
  eq('deposit not performance', v.pnl, ZERO);
  eq('deposit moves base', v.pf.base, D('15000')); }
eq('symbol encoding', E.encSym('^GSPC'), '~5EGSPC');
eq('slug', E.slug('Mary-Jane O\'Hara'), 'mary-jane-o-hara');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
