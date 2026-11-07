import { describe, expect, it } from 'vitest'
import { fileIconClass } from './fileIcon'

describe('fileIconClass', () => {
  it('maps programming language files to colored icon classes', () => {
    expect(fileIconClass('APduBlockingQueue.java')).toBe('java-icon medium-purple')
    expect(fileIconClass('src/App.tsx')).toBe('tsx-icon light-blue')
    expect(fileIconClass('main.ts')).toBe('ts-icon medium-blue')
    expect(fileIconClass('script.py')).toBe('python-icon dark-blue')
    expect(fileIconClass('lib.rs')).toBe('rust-icon medium-maroon')
    expect(fileIconClass('main.go')).toBe('go-icon medium-blue')
  })

  it('recognizes well-known filenames without extensions', () => {
    expect(fileIconClass('Dockerfile')).toBe('docker-icon dark-blue')
    expect(fileIconClass('package.json')).toBe('npm-icon medium-red')
  })

  it('returns null for unknown file types so callers can fall back', () => {
    expect(fileIconClass('data.unknownext')).toBeNull()
    expect(fileIconClass('')).toBeNull()
  })
})