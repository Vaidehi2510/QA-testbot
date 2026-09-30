#!/usr/bin/env python3
"""Extract a GitHub source archive as data; reject links and escaping paths."""
import hashlib
import json
import pathlib
import sys
import tarfile


def unpack(archive, attestation, destination):
    archive = pathlib.Path(archive)
    expected = json.loads(pathlib.Path(attestation).read_text())['sourceSha256']
    if hashlib.sha256(archive.read_bytes()).hexdigest() != expected:
        raise ValueError('Source archive does not match its trusted attestation')
    destination = pathlib.Path(destination).resolve()
    destination.mkdir(parents=True, exist_ok=False)
    total = 0
    with tarfile.open(archive, 'r:gz') as source:
        roots = set()
        for count, member in enumerate(source):
            if count >= 30000:
                raise ValueError('Too many source archive entries')
            relative = pathlib.PurePosixPath(member.name)
            if relative.is_absolute() or '..' in relative.parts or not relative.parts or '\\' in member.name:
                raise ValueError('Unsafe source archive path')
            roots.add(relative.parts[0])
            if len(roots) > 1:
                raise ValueError('Archive has more than one source root')
            if not (member.isfile() or member.isdir()):
                raise ValueError('Source archive contains an unsupported link or device')
            if len(relative.parts) == 1:
                if not member.isdir():
                    raise ValueError('Archive source root must be a directory')
                continue
            target = destination.joinpath(*relative.parts[1:])
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                total += member.size
                if member.size > 25 * 1024 * 1024 or total > 250 * 1024 * 1024:
                    raise ValueError('Source archive exceeds extraction size limits')
                target.parent.mkdir(parents=True, exist_ok=True)
                with source.extractfile(member) as incoming, target.open('xb') as outgoing:
                    while chunk := incoming.read(1024 * 1024):
                        outgoing.write(chunk)
                target.chmod(0o755 if member.mode & 0o111 else 0o644)


if __name__ == '__main__':
    unpack(*sys.argv[1:])
