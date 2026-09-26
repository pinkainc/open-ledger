// Identifiers the ledger assigns. Same alphabet and length as the reference
// ("$wlt.-2vcyddudkeQg6cbj", thread "-2vdHFDt8vRBDNftw"); opaque to clients, so only
// the prefix and shape are part of the contract.
import { customAlphabet } from 'nanoid'

const body = customAlphabet('-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz', 16)

export const newLuid = (prefix: string) => `${prefix}.-${body()}`
export const newThread = () => `-${body()}`
