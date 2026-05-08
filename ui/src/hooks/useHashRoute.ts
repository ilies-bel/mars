import { useEffect, useState } from 'react'

const currentHash = (): string =>
  typeof window === 'undefined' ? '#/' : window.location.hash || '#/'

export const useHashRoute = (): string => {
  const [hash, setHash] = useState<string>(currentHash())

  useEffect(() => {
    const onChange = () => setHash(currentHash())
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])

  return hash
}
