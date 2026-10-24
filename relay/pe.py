#!/usr/bin/env python3
"""PE report for the relay: structure, imports, version info, strings, entry code.

A full disassembler is not installed here and cannot be (no Hopper/Ghidra/IDA),
so this uses two libraries that are ordinary Python packages: pefile for the
carrier and capstone for the instruction text. The output is facts about the
binary — sections, imports, exports, resources, capabilities inferred from the
import table, and a bounded disassembly of the entry point — never the file.
"""

import json
import re
import sys
import hashlib
import math
from collections import Counter

import pefile
from capstone import Cs, CS_ARCH_X86, CS_MODE_64, CS_MODE_32

INTERESTING_IMPORTS = {
    'CreateProcessW', 'CreateProcessAsUserW', 'ShellExecuteW', 'ShellExecuteExW', 'WinExec',
    'CreateToolhelp32Snapshot', 'OpenProcess', 'VirtualAllocEx', 'WriteProcessMemory', 'CreateRemoteThread',
    'NtCreateThreadEx', 'SetWindowsHookExW', 'GetAsyncKeyState', 'BitBlt',
    'RegOpenKeyExW', 'RegSetValueExW', 'RegCreateKeyExW',
    'InternetOpenW', 'InternetOpenUrlW', 'WinHttpOpen', 'HttpSendRequestW',
    'CreateServiceW', 'StartServiceW', 'OpenSCManagerW', 'ChangeServiceConfigW',
    'AdjustTokenPrivileges', 'OpenProcessToken', 'LookupPrivilegeValueW',
    'WSAStartup', 'socket', 'connect', 'bind', 'listen',
    'CreateFileW', 'ReadFile', 'WriteFile', 'DeviceIoControl',
    'WTSQueryUserToken', 'ImpersonateLoggedOnUser',
    'CryptProtectData', 'CryptUnprotectData', 'BCryptEncrypt',
    'SetThreadExecutionState', 'SetWinEventHook', 'SetWindowsHookExA',
}

CERT_NOISE = re.compile(rb'(?i)digicert|sectigo|verisign|globalsign|symantec|thawte|entrust|usertrust|comodo|w3\.org|schemas\.microsoft\.com|ocsp\.|cacerts|crl[0-9]?\.')

INTERESTING_STRINGS = re.compile(
    rb'(?i)(https?://[a-z0-9._~:/?#\[\]@!$&\'()*+,;=%-]{6,120}'
    rb'|\\\\\.\\pipe\\[A-Za-z0-9_.-]{2,60}'
    rb'|[A-Za-z]:\\\\[A-Za-z0-9 _.-]{2,80}\.exe'
    rb'|--[a-z][a-z0-9-]{2,30}'
    rb'|[a-z0-9-]+\.(?:api|openai|anthropic|claude|chatgpt)\.(?:com|ai)'
    rb'|Software\\\\[A-Za-z0-9\\\\ ]{3,60}'
    rb'|[A-Za-z0-9_-]{0,20}(?:token|secret|apikey|api_key)[A-Za-z0-9_-]{0,20})'
)


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def entropy(data):
    if not data:
        return 0.0
    counts = Counter(data)
    total = len(data)
    return round(-sum((c / total) * math.log2(c / total) for c in counts.values()), 3)


def disassemble(pe, limit=160):
    is64 = pe.FILE_HEADER.Machine == 0x8664
    md = Cs(CS_ARCH_X86, CS_MODE_64 if is64 else CS_MODE_32)
    try:
        ep = pe.OPTIONAL_HEADER.AddressOfEntryPoint
        code = None
        for section in pe.sections:
            start = section.VirtualAddress
            end = start + max(section.Misc_VirtualSize, section.SizeOfRawData)
            if start <= ep < end:
                offset = ep - start
                code = section.get_data()[offset:offset + limit * 8]
                break
        if code is None:
            return []
        return [f'{ins.address:08x}  {ins.mnemonic} {ins.op_str}'.strip() for ins in md.disasm(code, ep)][:limit]
    except Exception as exc:  # noqa: BLE001 - report, never fail the job
        return [f'disassembly failed: {exc}']


GO_BUILDINFO = re.compile(rb'\xff Go buildinf:')


def go_buildinfo(data):
    """Go embeds its own manifest: toolchain, module list, build flags."""
    if not GO_BUILDINFO.search(data):
        return None
    out = {'present': True, 'go_version': None, 'modules': [], 'build_settings': []}
    m = re.search(rb'go1\.\d+(?:\.\d+)?', data)
    if m:
        out['go_version'] = m.group(0).decode()
    # Module table entries look like: dep\t<path>\t<version>\t<hash>
    for hit in re.finditer(rb'(?m)^(dep|=>)\t([\w./~-]{3,120})\t(v[\w.+-]{1,40}|\S{0,40})', data):
        out['modules'].append({'kind': hit.group(1).decode(), 'path': hit.group(2).decode(), 'version': hit.group(3).decode()})
        if len(out['modules']) >= 300:
            break
    if not out['modules']:
        # Older Go: a `path\tversion\th1:` table without the `dep` prefix.
        for hit in re.finditer(rb'(?m)^([\w./~-]{3,120})\t(v[\w.+-]{1,40})\th1:', data):
            out['modules'].append({'kind': 'dep', 'path': hit.group(1).decode(), 'version': hit.group(2).decode()})
            if len(out['modules']) >= 300:
                break
    for hit in re.finditer(rb'(?m)^build\t([-\w./=]+)\t(.{0,120})$', data):
        out['build_settings'].append(f'{hit.group(1).decode()}={hit.group(2).decode(errors="replace")}')
    return out


def symbol_families(data, limit=60):
    """Crude but useful: which package prefixes recur in the symbol table."""
    counts = Counter()
    for hit in re.finditer(rb'(?:[a-z0-9_-]+\.)+[a-z0-9_/-]{3,40}\.[A-Z][A-Za-z0-9_]{2,40}', data):
        name = hit.group(0).decode('utf-8', 'replace')
        parts = name.split('.')
        if len(parts) >= 3:
            counts['.'.join(parts[:-1])] += 1
    return [{'prefix': k, 'n': v} for k, v in counts.most_common(limit)]


def main(path):
    pe = pefile.PE(path, fast_load=True)
    pe.parse_data_directories(directories=[
        pefile.DIRECTORY_ENTRY['IMAGE_DIRECTORY_ENTRY_IMPORT'],
        pefile.DIRECTORY_ENTRY['IMAGE_DIRECTORY_ENTRY_EXPORT'],
        pefile.DIRECTORY_ENTRY['IMAGE_DIRECTORY_ENTRY_RESOURCE'],
        pefile.DIRECTORY_ENTRY['IMAGE_DIRECTORY_ENTRY_DELAY_IMPORT'],
        pefile.DIRECTORY_ENTRY['IMAGE_DIRECTORY_ENTRY_DEBUG'],
    ])

    imports, interesting = {}, []
    for entry in getattr(pe, 'DIRECTORY_ENTRY_IMPORT', []):
        dll = entry.dll.decode('utf-8', 'replace')
        names = []
        for imp in entry.imports:
            if imp.name:
                names.append(imp.name.decode('utf-8', 'replace'))
                if names[-1] in INTERESTING_IMPORTS:
                    interesting.append(f'{dll}!{names[-1]}')
        imports[dll] = names[:400]

    exports = []
    if hasattr(pe, 'DIRECTORY_ENTRY_EXPORT'):
        exports = [s.name.decode('utf-8', 'replace') for s in pe.DIRECTORY_ENTRY_EXPORT.symbols if s.name][:200]

    version = {}
    for fileinfo in getattr(pe, 'FileInfo', []) or []:
        for entry in fileinfo:
            if entry.Key == b'StringFileInfo':
                for table in entry.StringTable:
                    for key, value in table.entries.items():
                        version[key.decode('utf-8', 'replace')] = value.decode('utf-8', 'replace')

    sections = [{
        'name': s.Name.rstrip(b'\x00').decode('utf-8', 'replace'),
        'virtual_size': s.Misc_VirtualSize,
        'raw_size': s.SizeOfRawData,
        'entropy': entropy(s.get_data()),
        'executable': bool(s.Characteristics & 0x20000000),
        'writable': bool(s.Characteristics & 0x80000000),
    } for s in pe.sections]

    data = pe.__data__
    strings = []
    seen = set()
    for match in INTERESTING_STRINGS.finditer(data):
        if CERT_NOISE.search(match.group(0)):
            continue
        value = match.group(0).decode('utf-8', 'replace')
        if value.lower() in seen:
            continue
        seen.add(value.lower())
        strings.append(value)
        if len(strings) >= 400:
            break

    delay = []
    for entry in getattr(pe, 'DIRECTORY_ENTRY_DELAY_IMPORT', []):
        delay.append(entry.dll.decode('utf-8', 'replace'))

    capabilities = []
    joined = ' '.join(interesting)
    for needle, label in [
        ('CreateProcess', 'spawns processes'),
        ('ShellExecute', 'opens files/URLs through the shell'),
        ('RegSetValueEx', 'writes the registry'),
        ('CreateServiceW', 'installs or starts a Windows service'),
        ('CreateRemoteThread', 'injects into another process'),
        ('SetWindowsHookEx', 'installs a Windows hook'),
        ('BitBlt', 'captures the screen'),
        ('WinHttp', 'speaks HTTP directly'),
        ('InternetOpen', 'speaks HTTP through WinINet'),
        ('WSAStartup', 'opens raw sockets'),
        ('CreateNamedPipe', 'uses named pipes'),
        ('CryptProtect', 'uses DPAPI'),
        ('SetWinEventHook', 'observes UI accessibility events'),
        ('LookupPrivilege', 'adjusts its own privileges'),
        ('CreateFileW', 'reads/writes files'),
    ]:
        if needle in joined:
            capabilities.append(label)
    for dll in imports:
        if 'wintrust' in dll.lower():
            capabilities.append('verifies signatures with wintrust')
        if 'dbghelp' in dll.lower():
            capabilities.append('can produce crash dumps')

    # Rust and Go leave fingerprints in the image; a toolchain tells us how the
    # carrier was built even when every symbol is stripped.
    toolchain = []
    for needle, label in [(b'rustc', 'rust'), (b'cargo', 'cargo'), (b'go1.', 'go'), (b'Go build ID', 'go'), (b'node.exe', 'node'), (b'electron', 'electron')]:
        if needle in data:
            toolchain.append(label)
    pdb = []
    for entry in getattr(pe, 'DIRECTORY_ENTRY_DEBUG', []):
        try:
            if entry.entry.PdbFileName:
                pdb.append(entry.entry.PdbFileName.decode('utf-8', 'replace').rstrip('\x00'))
        except Exception:  # noqa: BLE001
            pass

    go = go_buildinfo(data)
    if go:
        toolchain.append('go')
    # Rust release binaries keep panic/format paths and the allocator shim even
    # when every symbol is stripped; a Bun build names itself in the version block.
    if re.search(rb'(?i)/rustc/|library/core/src|library/std/src|rust_begin_unwind|RUST_BACKTRACE|core::fmt', data):
        toolchain.append('rust')
    if b'clap-rs/clap' in data or b'docs.rs/' in data:
        toolchain.append('rust')
    if re.search(rb'(?i)\bbun\b.*version|/bun/|@bun', data):
        toolchain.append('bun')
    if b'electron' in bytes(data).lower():
        toolchain.append('electron')

    out = {
        'go_build': go,
        'symbol_families': symbol_families(data),
        'toolchain': sorted(set(toolchain)),
        'pdb': pdb[:5],
        'rich_header_present': bool(getattr(pe, 'RICH_HEADER', None)),
        'file': path.split('/')[-1],
        'size': len(data),
        'sha256': sha256(path),
        'machine': hex(pe.FILE_HEADER.Machine),
        'is_dll': bool(pe.FILE_HEADER.Characteristics & 0x2000),
        'subsystem': pe.OPTIONAL_HEADER.Subsystem,
        'timestamp': pe.FILE_HEADER.TimeDateStamp,
        'entry_point': hex(pe.OPTIONAL_HEADER.AddressOfEntryPoint),
        'image_base': hex(pe.OPTIONAL_HEADER.ImageBase),
        'sections': sections,
        'imports': imports,
        'delay_imports': delay,
        'exports': exports[:80],
        'version': version,
        'interesting_imports': sorted(set(interesting)),
        'capabilities': capabilities,
        'strings': strings,
        'entry_disassembly': disassemble(pe),
        'debug': [d.struct.Type for d in getattr(pe, 'DIRECTORY_ENTRY_DEBUG', [])],
        'overlay_bytes': len(pe.get_overlay_data_start_offset() and data[pe.get_overlay_data_start_offset():]) if pe.get_overlay_data_start_offset() else 0,
    }
    pe.close()
    return out


if __name__ == '__main__':
    try:
        print(json.dumps(main(sys.argv[1])))
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({'file': sys.argv[1].split('/')[-1], 'error': f'{type(exc).__name__}: {exc}'}))
