"""Suppress sustained harmonic energy before percussion discovery in a full mix.

This prepares an internal analysis signal; detected sounds still get their own
reference assets and patches. Blocks overlap so long recordings stay bounded.
"""
import numpy as np
from scipy import signal, ndimage


def percussion_audio(audio, sr):
    size, hop = 2048, round(sr * 0.005)
    result = np.zeros_like(audio)
    block, padding = 20 * sr, sr
    for start in range(0, len(audio), block):
        end = min(len(audio), start + block)
        lo, hi = max(0, start - padding), min(len(audio), end + padding)
        chunk = audio[lo:hi]
        _, _, z = signal.stft(chunk.mean(1), fs=sr, nperseg=size, noverlap=size-hop)
        magnitude = np.abs(z)
        harmonic = ndimage.median_filter(magnitude, size=(1, 81))
        percussive = ndimage.median_filter(magnitude, size=(17, 1))
        mask = percussive**2 / np.maximum(percussive**2 + harmonic**2, 1e-20)
        for channel in range(audio.shape[1]):
            _, _, spectrum = signal.stft(chunk[:, channel], fs=sr, nperseg=size, noverlap=size-hop)
            _, separated = signal.istft(spectrum * mask, fs=sr, nperseg=size, noverlap=size-hop)
            result[start:end, channel] = separated[start-lo:end-lo]
    return result
