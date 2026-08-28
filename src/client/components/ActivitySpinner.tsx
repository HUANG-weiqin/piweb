interface ActivitySpinnerProps {
  className: string;
  strokeWidth?: number;
}

/** A compositor-stable circular indicator with a rounded moving arc. */
export function ActivitySpinner({
  className,
  strokeWidth = 2,
}: ActivitySpinnerProps) {
  return <svg
    className={`activity-spinner ${className}`}
    viewBox="0 0 14 14"
    aria-hidden="true"
    focusable="false"
  >
    <circle
      className="activity-spinner-track"
      cx="7"
      cy="7"
      r="5.5"
      strokeWidth={strokeWidth}
    />
    <circle
      className="activity-spinner-arc"
      cx="7"
      cy="7"
      r="5.5"
      strokeWidth={strokeWidth}
      strokeDasharray="9 26"
      strokeLinecap="round"
    />
  </svg>;
}
