export default function Logo({ compact = false }) {
  return (
    <div className="brand" aria-label="MediSage">
      <div className="brand-mark">
        <img src="/medisage-logo.svg" alt="" aria-hidden="true" />
      </div>
      {!compact && (
        <div className="brand-copy">
          <strong>MediSage</strong>
          <span>Clinical knowledge workspace</span>
        </div>
      )}
    </div>
  );
}
