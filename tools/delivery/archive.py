#!/usr/bin/env python3
"""Extract data-only build outputs; reject links, traversal, duplicate and oversized members."""
import pathlib
import sys
import tarfile


def unpack(archive, destination, limit=4 * 1024**3):
    limit = int(limit)
    root = pathlib.Path(destination).resolve()
    root.mkdir(parents=True, exist_ok=True)
    total, seen = 0, set()
    with tarfile.open(archive) as source:
        members = source.getmembers()
        if len(members) > 200000:
            raise ValueError('too many archive members')
        for member in members:
            name = pathlib.PurePosixPath(member.name)
            if name.is_absolute() or '..' in name.parts or '\\' in member.name:
                raise ValueError('unsafe member path')
            target = root.joinpath(*name.parts)
            if not target.resolve().is_relative_to(root):
                raise ValueError('path escapes destination')
            if member.name in seen or not (member.isfile() or member.isdir()):
                raise ValueError('duplicate, link or special member forbidden')
            seen.add(member.name)
            total += member.size
            if member.size < 0 or total > limit:
                raise ValueError('archive too large')
        for member in members:
            target = root.joinpath(*pathlib.PurePosixPath(member.name).parts)
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with source.extractfile(member) as reader, open(target, 'xb') as writer:
                    while data := reader.read(1024 * 1024):
                        writer.write(data)

if __name__ == '__main__':
    unpack(*sys.argv[1:3])
