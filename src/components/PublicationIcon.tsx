export default function PublicationIcon(props: { pending?: boolean; label: string; status: string }) {
  return <span class="publication-icon" classList={{ 'is-pending': props.pending }} role="img" aria-label={props.label} title={`${props.label} · ${props.status}`}>
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" />
      <ellipse cx="12" cy="12" rx="4" ry="8.5" />
      <path d="M3.5 12h17" />
    </svg>
  </span>;
}
