export function QuestionFields({ questions, picks, disabled, onPick, onOther }) {
  return questions.map((q, qi) => <fieldset key={qi} className="question-set" disabled={disabled}>
    <legend>{q.header ? <span className="question-header">{q.header}</span> : null}{q.question}{q.multiSelect ? <span className="question-hint"> Pick any.</span> : null}</legend>
    <div className="question-options">
      {q.options.map(o => <button key={o.label} type="button" className="question-option" aria-pressed={picks[qi].labels.includes(o.label)} onClick={() => onPick(qi, o.label)}>
        <span className="question-label">{o.label}</span>
        {o.description ? <span className="question-description">{o.description}</span> : null}
      </button>)}
      <button type="button" className="question-option" aria-pressed={picks[qi].other !== null} onClick={() => onPick(qi, null)}>
        <span className="question-label">Other</span>
      </button>
      {picks[qi].other !== null ? <input type="text" className="question-other" aria-label={`Your answer to: ${q.question}`} maxLength={500} autoFocus
        value={picks[qi].other} onChange={e => onOther(qi, e.target.value)} /> : null}
    </div>
  </fieldset>);
}
