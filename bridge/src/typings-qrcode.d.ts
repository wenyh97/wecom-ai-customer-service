declare module 'qrcode' {
  interface QRCodeToStringOptions {
    errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H'
    margin?: number
    type?: 'svg' | 'utf8' | 'terminal'
    width?: number
  }

  const QRCode: {
    toString: (text: string, options?: QRCodeToStringOptions) => Promise<string>
  }

  export default QRCode
}
