<script lang="ts">
  // Large gradient illustrations used on the item tiles (folder / review file / card).
  type Props = { kind: 'folder' | 'file' | 'card' }
  let { kind }: Props = $props()
</script>

{#if kind === 'folder'}
  <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="fldTab" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#c7d2fe" />
        <stop offset="1" stop-color="#a5b4fc" />
      </linearGradient>
      <linearGradient id="fldBody" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#8b9bfb" />
        <stop offset="1" stop-color="#6366f1" />
      </linearGradient>
      <linearGradient id="fldGloss" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#ffffff" stop-opacity=".38" />
        <stop offset="1" stop-color="#ffffff" stop-opacity="0" />
      </linearGradient>
    </defs>
    <path d="M6 16a4 4 0 0 1 4-4h12l5 5h23a4 4 0 0 1 4 4v3H6z" fill="url(#fldTab)" />
    <path d="M6 21h48v25a4 4 0 0 1-4 4H10a4 4 0 0 1-4-4z" fill="url(#fldBody)" />
    <path d="M6 21h48v7H6z" fill="url(#fldGloss)" />
    <path d="M6 21h48" stroke="#ffffff" stroke-opacity=".45" stroke-width="1" />
  </svg>
{:else if kind === 'file'}
  <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="remPaper" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#f5f7fd" />
        <stop offset="1" stop-color="#e3e7f3" />
      </linearGradient>
      <linearGradient id="remBell" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#fbbf24" />
        <stop offset="1" stop-color="#f59e0b" />
      </linearGradient>
    </defs>
    <path d="M14 9a3 3 0 0 1 3-3h19l14 14v36a3 3 0 0 1-3 3H17a3 3 0 0 1-3-3z" fill="url(#remPaper)" stroke="#cbd3e6" stroke-width="1.4" />
    <path d="M36 6v11a3 3 0 0 0 3 3h11z" fill="#dde3f0" stroke="#cbd3e6" stroke-width="1.4" stroke-linejoin="round" />
    <path d="M22 30h18M22 37h18M22 44h11" stroke="#b3bdd4" stroke-width="2.4" stroke-linecap="round" />
    <circle cx="46" cy="45" r="13" fill="url(#remBell)" />
    <path d="M46 37.5c-3 0-5.4 2.4-5.4 5.4 0 2.6-1.4 3.6-1.4 3.6h13.6s-1.4-1-1.4-3.6c0-3-2.4-5.4-5.4-5.4z" fill="#ffffff" />
    <path d="M44 48.2a2 2 0 0 0 4 0" stroke="#ffffff" stroke-width="1.8" stroke-linecap="round" fill="none" />
  </svg>
{:else}
  <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="cardBack" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#a78bfa" />
        <stop offset="1" stop-color="#7c7ff5" />
      </linearGradient>
      <linearGradient id="cardFront" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#ffffff" />
        <stop offset="1" stop-color="#e6e9f7" />
      </linearGradient>
    </defs>
    <rect x="16" y="14" width="38" height="28" rx="6" fill="url(#cardBack)" transform="rotate(8 35 28)" />
    <rect x="9" y="20" width="38" height="28" rx="6" fill="url(#cardFront)" stroke="#cbd3e6" stroke-width="1.4" />
    <path d="M16 30h24M16 37h15" stroke="#b3bdd4" stroke-width="2.4" stroke-linecap="round" />
  </svg>
{/if}
