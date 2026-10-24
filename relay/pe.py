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

    out = {
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
