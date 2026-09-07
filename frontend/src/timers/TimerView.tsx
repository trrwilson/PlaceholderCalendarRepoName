import { useState } from 'react'

import { TIMER_MAX_SECONDS, TIMER_MIN_SECONDS, type Timer } from './types'

interface Props {
  timer: Timer | null
  remainingMs: number
  alarm: boolean
  onStart: (durationSeconds: number, label: string | null) => void
  onExtend: (addSeconds: number) => void
  onCancel: () => void
  onDismiss: () => void
}

const PRESETS_MIN = [1, 3, 5, 10, 15, 30, 45, 60, 120]
const LABEL_CHIPS = ['Food', 'Oven', 'Laundry', 'Kids', 'Homework']
const STEP_SECONDS = 60

function formatClock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const pad = (value: number) => String(value).padStart(2, '0')
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`
}

function ProgressRing({ fraction }: { fraction: number }) {
  const radius = 46
  const circumference = 2 * Math.PI * radius
  const clamped = Math.min(1, Math.max(0, fraction))
  return (
    <svg className="timer-ring" viewBox="0 0 100 100" aria-hidden="true">
      <circle className="timer-ring-track" cx="50" cy="50" r={radius} />
      <circle
        className="timer-ring-value"
        cx="50"
        cy="50"
        r={radius}
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - clamped)}
      />
    </svg>
  )
}

function TimerSetup({ onStart }: { onStart: Props['onStart'] }) {
  const [seconds, setSeconds] = useState(5 * 60)
  const [label, setLabel] = useState<string | null>(null)

  const clamp = (value: number) => Math.min(TIMER_MAX_SECONDS, Math.max(0, value))
  const startable = seconds >= TIMER_MIN_SECONDS && seconds <= TIMER_MAX_SECONDS

  return (
    <div className="timer-setup">
      <p className="section-kicker">New timer</p>
      <div className="timer-dial">
        <button
          className="timer-step"
          aria-label="Subtract one minute"
          onClick={() => setSeconds((value) => clamp(value - STEP_SECONDS))}
        >
          −
        </button>
        <strong className="timer-dial-value">{formatClock(seconds * 1000)}</strong>
        <button
          className="timer-step"
          aria-label="Add one minute"
          onClick={() => setSeconds((value) => clamp(value + STEP_SECONDS))}
        >
          +
        </button>
      </div>
      <div className="timer-presets">
        {PRESETS_MIN.map((minutes) => (
          <button
            key={minutes}
            className={seconds === minutes * 60 ? 'selected' : ''}
            onClick={() => setSeconds(minutes * 60)}
          >
            {minutes < 60 ? `${minutes} min` : `${minutes / 60} hr`}
          </button>
        ))}
      </div>
      <div className="timer-labels" role="group" aria-label="Timer label">
        {LABEL_CHIPS.map((chip) => (
          <button
            key={chip}
            className={label === chip ? 'selected' : ''}
            aria-pressed={label === chip}
            onClick={() => setLabel((current) => (current === chip ? null : chip))}
          >
            {chip}
          </button>
        ))}
      </div>
      <button
        className="timer-start"
        disabled={!startable}
        onClick={() => startable && onStart(seconds, label)}
      >
        Start timer
      </button>
    </div>
  )
}

function TimerRunning({
  timer,
  remainingMs,
  onExtend,
  onCancel,
}: {
  timer: Timer
  remainingMs: number
  onExtend: Props['onExtend']
  onCancel: Props['onCancel']
}) {
  const elapsed = timer.duration_seconds * 1000 - remainingMs
  return (
    <div className="timer-running">
      <div className="timer-countdown">
        <ProgressRing fraction={elapsed / (timer.duration_seconds * 1000)} />
        <div className="timer-countdown-text">
          <strong>{formatClock(remainingMs)}</strong>
          {timer.label && <span>{timer.label}</span>}
        </div>
      </div>
      <div className="timer-controls">
        <button onClick={() => onExtend(60)}>+1 min</button>
        <button onClick={() => onExtend(5 * 60)}>+5 min</button>
        <button className="timer-cancel" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  )
}

function TimerAlarm({
  timer,
  onExtend,
  onDismiss,
}: {
  timer: Timer
  onExtend: Props['onExtend']
  onDismiss: Props['onDismiss']
}) {
  return (
    <button className="timer-alarm" aria-label="Dismiss timer" onClick={onDismiss}>
      <span className="timer-alarm-mark" aria-hidden="true">
        ⏰
      </span>
      <strong>Timer finished</strong>
      {timer.label && <span className="timer-alarm-label">{timer.label}</span>}
      <span className="timer-alarm-actions">
        <span
          role="button"
          tabIndex={0}
          className="timer-snooze"
          onClick={(event) => {
            event.stopPropagation()
            onExtend(5 * 60)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.stopPropagation()
              onExtend(5 * 60)
            }
          }}
        >
          +5 min
        </span>
        <span className="timer-dismiss">Dismiss</span>
      </span>
    </button>
  )
}

export function TimerView({ timer, remainingMs, alarm, onStart, onExtend, onCancel, onDismiss }: Props) {
  return (
    <div className="timer-view">
      {alarm && timer ? (
        <TimerAlarm timer={timer} onExtend={onExtend} onDismiss={onDismiss} />
      ) : timer && timer.state === 'running' ? (
        <TimerRunning timer={timer} remainingMs={remainingMs} onExtend={onExtend} onCancel={onCancel} />
      ) : (
        <TimerSetup onStart={onStart} />
      )}
    </div>
  )
}
