import { useState } from 'react';
import { useService } from '../../app/context';
import type { DecisionReview, HandReview } from '../../coach/analyzer';
import type { EquityQueryResult } from '../../coach/equityQuery';
import { cx, dateTime, fmt, pct, signed } from '../format';

const VERDICT_LABEL: Record<DecisionReview['verdict'], string> = { good: 'Good', fine: 'Fine', close: 'Close', questionable: 'Questionable', mistake: 'Likely mistake' };

export function DecisionList({ review }: { review: HandReview }) {
  return (
    <div className="review">
      <p className="review-head">{review.headline}</p>
      {review.decisions.map((d, i) => (
        <article key={i} className={cx('decision', `verdict-${d.verdict}`)}>
          <header>
            <span className="street-tag">{d.street}</span>
            <strong>{d.action}</strong>
            <span className="verdict">{VERDICT_LABEL[d.verdict]}</span>
          </header>
          <p>{d.text}</p>
          {(d.requiredEquity !== null || d.equity !== null) && (
            <dl className="decision-nums">
              {d.requiredEquity !== null && <div><dt>Needed</dt><dd>{pct(d.requiredEquity)}</dd></div>}
              {d.equity !== null && <div><dt>Est. equity</dt><dd>{pct(d.equity)}{d.exact ? ' (exact vs range)' : d.equityMargin ? ` ±${pct(d.equityMargin, 1)}` : ''}</dd></div>}
              {d.evLossBB > 0.05 && <div><dt>Est. cost</dt><dd>{d.evLossBB.toFixed(1)} BB</dd></div>}
            </dl>
          )}
          <details>
            <summary>How this was worked out</summary>
            <div className="work">
              <div><h5>What was known</h5><ul>{d.known.map((k, j) => <li key={j}>{k}</li>)}</ul></div>
              <div><h5>What was estimated</h5><ul>{d.estimated.map((k, j) => <li key={j}>{k}</li>)}</ul></div>
            </div>
          </details>
        </article>
      ))}
      {review.opportunities.length > 0 && (
        <div className="review-block">
          <h4>Opportunities</h4>
          <ul>{review.opportunities.map((o, i) => <li key={i}>{o}</li>)}</ul>
        </div>
      )}
      {review.showdownNotes.length > 0 && (
        <div className="review-block">
          <h4>Revealed at showdown</h4>
          <ul>{review.showdownNotes.map((o, i) => <li key={i}>{o}</li>)}</ul>
        </div>
      )}
      {review.riskNote && (
        <div className="review-block">
          <h4>Risk</h4>
          <p>{review.riskNote}</p>
        </div>
      )}
    </div>
  );
}

function EquityCalculator() {
  const service = useService();
  const [sideA, setSideA] = useState('AhKh');
  const [sideB, setSideB] = useState('QQ+, AKs, AKo');
  const [board, setBoard] = useState('');
  const [result, setResult] = useState<EquityQueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      setResult(await service.runEquity({ sideA, sideB, board, iterations: 100000 }));
    } catch (e) {
      setResult(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel">
      <h2>Equity calculator</h2>
      <p className="muted">Enter exact cards (AhKh) or ranges (QQ+, AKs, 99-77, top15%). Uses exact enumeration when practical, Monte Carlo otherwise, and tells you which.</p>
      <div className="form-row">
        <label className="field"><span className="field-label">Hand or range A</span><input type="text" value={sideA} onChange={(e) => setSideA(e.target.value)} /></label>
        <label className="field"><span className="field-label">Hand or range B</span><input type="text" value={sideB} onChange={(e) => setSideB(e.target.value)} /></label>
        <label className="field"><span className="field-label">Board (optional)</span><input type="text" value={board} placeholder="Ks 7d 2c" onChange={(e) => setBoard(e.target.value)} /></label>
      </div>
      <button type="button" className="btn btn-gold" disabled={busy} onClick={() => void run()}>{busy ? 'Calculating…' : 'Calculate'}</button>
      {error && <p className="form-error" role="alert">{error}</p>}
      {result && (
        <div className="equity-result">
          <div className="equity-bars" role="img" aria-label={`A ${pct(result.a.equity, 1)}, B ${pct(result.bEquity, 1)}`}>
            <span className="eq-a" style={{ width: `${result.a.equity * 100}%` }} />
            <span className="eq-b" style={{ width: `${result.bEquity * 100}%` }} />
          </div>
          <div className="equity-sides">
            <div><b>{pct(result.a.equity, 2)}</b><span>A: {result.describeA}</span></div>
            <div><b>{pct(result.bEquity, 2)}</b><span>B: {result.describeB}</span></div>
          </div>
          <p className="muted">
            {result.a.exact ? `Exact: all ${fmt(result.a.samples)} runouts enumerated.` : `Monte Carlo: ${fmt(result.a.samples)} runouts, margin about ±${pct(result.a.stderr * 2, 2)}.`}
            {' '}Win {pct(result.a.win, 1)}, tie {pct(result.a.tie, 1)}.
          </p>
        </div>
      )}
    </section>
  );
}

export function CoachScreen() {
  const service = useService();
  const { recommendations, recentReviews, reviewTotals } = service;
  const latest = recommendations[0];
  const [openId, setOpenId] = useState<string | null>(null);
  const totals = reviewTotals.good + reviewTotals.fine + reviewTotals.close + reviewTotals.questionable + reviewTotals.mistake;

  return (
    <div className="screen">
      <header className="screen-head">
        <h1>Poker Coach</h1>
        <p>Every completed hand gets a review, using only what you could see. Opponent ranges are clearly marked as estimates, and nothing is called GTO.</p>
      </header>

      <section className="grid-2">
        <div className="panel">
          <h2>Training recommendation</h2>
          {latest ? (
            <div className="training">
              <p className="training-level">Current level: <b>{latest.level}</b></p>
              <p className="training-focus"><span>Focus</span> {latest.focus}</p>
              <p>{latest.message}</p>
              {latest.strongest.length > 0 && <p><b>Strongest:</b> {latest.strongest.join(', ')}.</p>}
              {latest.weakest.length > 0 && <p><b>Weakest:</b> {latest.weakest.join(', ')}.</p>}
              <p className="muted"><b>Difficulty:</b> {latest.difficulty === 'raise' ? 'consider moving up' : latest.difficulty === 'lower' ? 'consider moving down' : 'stay where you are'}. {latest.difficultyReason}</p>
              <p className="muted">Updated after hand {fmt(latest.handsAtCreation)}, on {dateTime(latest.ts)}. Recommendations refresh every 25 hands.</p>
            </div>
          ) : (
            <p className="muted">Your first recommendation arrives after 25 hands.</p>
          )}
        </div>
        <div className="panel">
          <h2>Decision quality</h2>
          {totals < 10 ? (
            <p className="muted">Reviews of your decisions will add up here as you play.</p>
          ) : (
            <>
              <div className="quality-bar" role="img" aria-label={`${reviewTotals.good} good, ${reviewTotals.fine} fine, ${reviewTotals.close} close, ${reviewTotals.questionable} questionable, ${reviewTotals.mistake} likely mistakes`}>
                {(['good', 'fine', 'close', 'questionable', 'mistake'] as const).map((k) => (
                  <span key={k} className={`q-${k}`} style={{ width: `${(reviewTotals[k] / totals) * 100}%` }} />
                ))}
              </div>
              <ul className="quality-legend">
                {(['good', 'fine', 'close', 'questionable', 'mistake'] as const).map((k) => (
                  <li key={k}><i className={`q-${k}`} />{VERDICT_LABEL[k]} <b>{fmt(reviewTotals[k])}</b></li>
                ))}
              </ul>
              <p className="muted">From {fmt(totals)} reviewed decisions. A "mistake" here is judged against estimated ranges, so treat these as prompts to look closer rather than final verdicts.</p>
            </>
          )}
        </div>
      </section>

      <EquityCalculator />

      <section className="panel">
        <h2>Recent reviews</h2>
        {recentReviews.length === 0 ? (
          <p className="muted">Reviews from this visit will appear here. Older ones are in Hand History.</p>
        ) : (
          <ul className="review-list">
            {recentReviews.slice(0, 20).map(({ record, review }) => (
              <li key={record.id}>
                <button type="button" className="review-row" aria-expanded={openId === record.id} onClick={() => setOpenId((id) => (id === record.id ? null : record.id))}>
                  <span className="review-cards">{review.heroCards}</span>
                  <span>{review.position}</span>
                  <span className="grow">{review.headline}</span>
                  <b className={record.heroNet > 0 ? 'pos' : record.heroNet < 0 ? 'neg' : ''}>{signed(record.heroNet)}</b>
                </button>
                {openId === record.id && <DecisionList review={review} />}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
