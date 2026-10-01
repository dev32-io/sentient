"""Exercise generated upstream patch's allocation/width boundary, not new crypto."""
from pathlib import Path
import importlib.util
import subprocess


def test_fixed_width_salt_before_hashing(tmp_path):
    script = Path(__file__).resolve().parents[2] / 'firmware/scripts/patch_srp_salt.py'
    spec = importlib.util.spec_from_file_location('cube_srp_patch', script)
    patch = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(patch)
    # Exact anchor guard prevents applying an unreviewed patch after SDK changes.
    try:
        patch.patch('different upstream implementation')
        raise AssertionError('unexpected upstream source accepted')
    except ValueError:
        pass
    fragment = patch.patch(patch.ANCHOR).split('    ESP_LOGD')[0]
    source = tmp_path / 'salt.c'
    source.write_text('''
#include <assert.h>
#include <stdlib.h>
#include <string.h>
struct salt { char *bytes_s; int len_s; };
int check(int original_len) {
    int salt_len=32, str_salt_len=original_len;
    struct salt storage={malloc(original_len ? original_len : 1),0};
    struct salt *hd=&storage;
    if (original_len) memset(hd->bytes_s,0x7f,original_len);
''' + fragment + '''
    assert(str_salt_len == 32 && hd->len_s == 32);
    for (int i=0;i<32;++i) assert((unsigned char)hd->bytes_s[i] == (i < 32-original_len ? 0 : 0x7f));
    free(hd->bytes_s); return 0;
error:
    free(hd->bytes_s); return 1;
}
int main(void) { for(int i=0;i<=32;++i) assert(check(i)==0); }
''')
    binary = tmp_path / 'salt'
    subprocess.run(['cc', '-std=c11', '-Wall', '-Wextra', '-Werror', '-fsanitize=address',
                    str(source), '-o', str(binary)], check=True)
    subprocess.run([str(binary)], check=True)
