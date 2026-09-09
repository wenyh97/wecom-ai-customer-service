declare module 'qrcode-terminal' {
  const qrcodeTerminal: {
    generate: (input: string, options?: { small?: boolean }) => void
  }

  export default qrcodeTerminal
}
