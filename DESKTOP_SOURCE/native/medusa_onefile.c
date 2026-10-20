// Copyright (C) 2026 NassLab — Nasser, France.
// SPDX-License-Identifier: AGPL-3.0-only
// See the repository LICENSE; dependencies retain their own licenses.

/* ============================================================================
 *  medusa_onefile.c  --  stub auto-extracteur "NMDSFX01"
 *
 *  Reconstruit par retro-ingenierie de Medusa_Engine_3.1.exe
 *  (stamp 1789368682 = 2026-09-14 08:51:22 heure de Paris).
 *
 *  Role : le stub est place en tete du .exe final ; toutes les DLL + l'exe
 *  moteur sont concatenes derriere lui, suivis d'un manifeste et d'un pied
 *  de 28 octets. Au lancement le stub se relit lui-meme, extrait le tout
 *  dans %LOCALAPPDATA%\NasscadMedusa\<stamp>\ puis lance le moteur en lui
 *  transmettant ses arguments, attend sa fin et renvoie son code de sortie.
 *
 *  Build (MinGW-w64) :
 *      windres medusa_onefile.rc -O coff -o medusa_onefile.res
 *      gcc -O2 -s -o medusa_onefile_stub.exe medusa_onefile.c medusa_onefile.res
 * ========================================================================== */

#include <windows.h>
#include <stdio.h>
#include <wchar.h>

#define SFX_MAGIC    0x3130584653444D4EULL          /* "NMDSFX01" en LE      */
#define APP_SUBDIR   L"NasscadMedusa"
#define ENGINE_EXE   L"Nasscad_Medusa_Engine_3.1.exe"
#define COPY_CHUNK   65536u                          /* 0x10000              */
#define MAX_FILES    4096u                           /* count-1 <= 0xFFF     */
#define MAX_NAME     512u                            /* nameLen-1 <= 0x1FF   */

/* -------------------------------------------------------------------------- */

static void fatal(const wchar_t *what)
{
    fwprintf(stderr, L"[medusa-onefile] FATAL: %ls (win32 err %lu)\n",
             what, GetLastError());
    ExitProcess(1);
}

/* lecture positionnee (pread) sur le handle de l'exe lui-meme */
static BOOL read_at(HANDLE h, unsigned long long off, void *buf, DWORD len)
{
    LARGE_INTEGER li;
    DWORD got = 0;
    li.QuadPart = (LONGLONG)off;
    if (!SetFilePointerEx(h, li, NULL, FILE_BEGIN)) return FALSE;
    if (!ReadFile(h, buf, len, &got, NULL))         return FALSE;
    return got == len;
}

/* mkdir -p : on repart de path+1 pour ne pas tenter de creer "C:" */
static void mkdirs(wchar_t *path)
{
    wchar_t *p;
    for (p = path + 1; *p; ++p) {
        if (*p == L'\\') {
            *p = 0;
            CreateDirectoryW(path, NULL);
            *p = L'\\';
        }
    }
    CreateDirectoryW(path, NULL);
}

/* -------------------------------------------------------------------------- */

int main(void)
{
    wchar_t self[MAX_PATH], base[MAX_PATH], dir[MAX_PATH];
    wchar_t ready[MAX_PATH], engine[MAX_PATH], outpath[MAX_PATH];
    unsigned char buf[COPY_CHUNK];
    HANDLE hself;
    LARGE_INTEGER fsz;
    unsigned long long magic = 0, stamp = 0, manifest_off = 0, cursor;
    unsigned int count = 0, i;
    DWORD n;

    /* --- 1. s'ouvrir soi-meme ------------------------------------------- */
    if (!GetModuleFileNameW(NULL, self, MAX_PATH)) fatal(L"GetModuleFileName");

    hself = CreateFileW(self, GENERIC_READ,
                        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                        NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (hself == INVALID_HANDLE_VALUE) fatal(L"open self");
    if (!GetFileSizeEx(hself, &fsz))   fatal(L"size self");
    if (fsz.QuadPart < 28)             fatal(L"file too small");

    /* --- 2. pied de fichier (28 octets, lu a l'envers) ------------------- */
    if (!read_at(hself, fsz.QuadPart -  8, &magic, 8))        fatal(L"read magic");
    if (magic != SFX_MAGIC)                fatal(L"no embedded archive (magic mismatch)");
    if (!read_at(hself, fsz.QuadPart - 16, &stamp, 8))        fatal(L"read stamp");
    if (!read_at(hself, fsz.QuadPart - 24, &manifest_off, 8)) fatal(L"read manifestOffset");
    if (!read_at(hself, fsz.QuadPart - 28, &count, 4))        fatal(L"read count");
    if (count == 0 || count > MAX_FILES)   fatal(L"bad file count");

    /* --- 3. dossier d'extraction ---------------------------------------- */
    n = GetEnvironmentVariableW(L"LOCALAPPDATA", base, MAX_PATH);
    if (n == 0 || n >= MAX_PATH) n = GetEnvironmentVariableW(L"TEMP", base, MAX_PATH);
    if (n == 0 || n >= MAX_PATH) fatal(L"no LOCALAPPDATA/TEMP");

    _snwprintf(dir,   MAX_PATH, L"%ls\\%ls\\%llu", base, APP_SUBDIR, stamp);
    dir[MAX_PATH - 1] = 0;
    _snwprintf(ready, MAX_PATH, L"%ls\\.ready", dir);
    ready[MAX_PATH - 1] = 0;

    /* --- 4. extraction (sautee si .ready existe deja) -------------------- */
    if (GetFileAttributesW(ready) == INVALID_FILE_ATTRIBUTES) {

        mkdirs(dir);
        cursor = manifest_off;

        for (i = 0; i < count; ++i) {
            unsigned short nlen = 0;
            char    nameA[MAX_NAME + 1];
            wchar_t nameW[MAX_NAME + 1];
            unsigned long long off = 0, size = 0, left;
            HANDLE ho;
            LARGE_INTEGER li;

            if (!read_at(hself, cursor, &nlen, 2))     fatal(L"manifest nameLen");
            cursor += 2;
            if (nlen == 0 || nlen > MAX_NAME)          fatal(L"manifest bad nameLen");
            if (!read_at(hself, cursor, nameA, nlen))  fatal(L"manifest name");
            cursor += nlen;
            nameA[nlen] = 0;
            if (!read_at(hself, cursor, &off, 8))      fatal(L"manifest offset");
            cursor += 8;
            if (!read_at(hself, cursor, &size, 8))     fatal(L"manifest size");
            cursor += 8;

            if (!MultiByteToWideChar(CP_UTF8, 0, nameA, -1, nameW, MAX_NAME))
                fatal(L"name to wide");

            _snwprintf(outpath, MAX_PATH, L"%ls\\%ls", dir, nameW);
            outpath[MAX_PATH - 1] = 0;

            ho = CreateFileW(outpath, GENERIC_WRITE, 0, NULL,
                             CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
            if (ho == INVALID_HANDLE_VALUE) fatal(L"create output file");

            li.QuadPart = (LONGLONG)off;
            if (!SetFilePointerEx(hself, li, NULL, FILE_BEGIN)) fatal(L"seek payload");

            for (left = size; left; ) {
                DWORD want = (DWORD)(left < COPY_CHUNK ? left : COPY_CHUNK);
                DWORD got = 0, put = 0, done = 0;
                if (!ReadFile(hself, buf, want, &got, NULL) || got != want)
                    fatal(L"read payload");
                while (done < got) {
                    if (!WriteFile(ho, buf + done, got - done, &put, NULL))
                        fatal(L"write payload");
                    done += put;
                }
                left -= got;
            }
            CloseHandle(ho);
        }

        /* marqueur : les prochains lancements sauteront l'extraction */
        {
            HANDLE hr = CreateFileW(ready, GENERIC_WRITE, 0, NULL,
                                    CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
            if (hr != INVALID_HANDLE_VALUE) CloseHandle(hr);
        }
    }

    CloseHandle(hself);

    /* --- 5. lancement du moteur ----------------------------------------- */
    _snwprintf(engine, MAX_PATH, L"%ls\\%ls", dir, ENGINE_EXE);
    engine[MAX_PATH - 1] = 0;
    if (GetFileAttributesW(engine) == INVALID_FILE_ATTRIBUTES)
        fatal(L"engine exe missing after extraction");

    {
        const wchar_t *cl = GetCommandLineW(), *rest;
        wchar_t *cmd;
        size_t need;
        STARTUPINFOW si;
        PROCESS_INFORMATION pi;
        DWORD code = 0;

        /* sauter argv[0] (avec ou sans guillemets), garder le reste tel quel */
        while (*cl == L' ' || *cl == L'\t') ++cl;
        if (*cl == L'"') {
            ++cl;
            while (*cl && *cl != L'"') ++cl;
            if (*cl == L'"') ++cl;
        } else {
            while (*cl && *cl != L' ' && *cl != L'\t') ++cl;
        }
        rest = cl;                       /* espace de separation inclus */

        need = wcslen(engine) + wcslen(rest) + 4;
        cmd  = (wchar_t *)HeapAlloc(GetProcessHeap(), 0, need * sizeof(wchar_t));
        if (!cmd) fatal(L"alloc cmdline");
        _snwprintf(cmd, need, L"\"%ls\"%ls", engine, rest);

        ZeroMemory(&si, sizeof si);
        si.cb = sizeof si;
        ZeroMemory(&pi, sizeof pi);

        if (!CreateProcessW(engine, cmd, NULL, NULL,
                            TRUE,            /* handles herites : stdio passe */
                            0, NULL, NULL, &si, &pi))
            fatal(L"CreateProcess engine");

        WaitForSingleObject(pi.hProcess, INFINITE);
        GetExitCodeProcess(pi.hProcess, &code);
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
        HeapFree(GetProcessHeap(), 0, cmd);

        return (int)code;
    }
}
