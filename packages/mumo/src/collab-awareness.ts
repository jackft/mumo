const PEER_COLORS = [
  '#e63946', '#2a9d8f', '#e9c46a', '#f4a261', '#457b9d',
  '#6a994e', '#c77dff', '#ff9a3c', '#4ecdc4', '#a8dadc',
]

export function peerColor(clientId: number): string {
  return PEER_COLORS[clientId % PEER_COLORS.length]!
}
