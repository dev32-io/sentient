"""Actual firmware SDK frames -> actual gateway gate/STT delayed-finalization boundary."""
from pathlib import Path
import os
import subprocess
from cube_envelope_host import envelope_link_args

UNIT = Path(__file__).resolve().parent
MAIN = UNIT.parents[1] / 'firmware/main'


def test_busy_refusal_preserves_committing_capture(tmp_path):
    cjson = Path(os.environ.get('IDF_PATH', Path.home() / 'esp/esp-idf')) / 'components/json/cJSON'
    source = tmp_path / 'busy.cc'
    source.write_text(r'''
#define main other_protocol_cases
#include "sentient_ws_protocol_host_test.cc"
#undef main
#include <iostream>
int main() {
    bool frame_available = false;
    SentientWsProtocolConfig cfg;
    cfg.on_pop_uplink_frame = [&](std::vector<uint8_t>& bytes) {
        if (!frame_available) return false;
        frame_available = false; bytes = {42}; return true;
    };
    SentientWsProtocol sdk(std::move(cfg));
    sdk.client_ = new MockClient;
    sdk.status_ = SdkStatus::Ready;
    for (std::string command; std::getline(std::cin, command);) {
        mock_text.clear();
        const int sent_before = mock_binary_sends;
        bool started = false;
        if (command == "start") started = sdk.start_streaming();
        else if (command == "end") sdk.stop_streaming();
        else if (command == "settle") sdk.settle_busy_refusal(); // Producer stopped at this boundary.
        else if (command == "pump") { frame_available = true; sdk.pump_uplink(); }
        else sdk.handle_text(command.data(), command.size());
        assert(mock_text.find("}{") == std::string::npos);
        std::cout << "{\"ready\":" << (sdk.status() == SdkStatus::Ready ? "true" : "false")
                  << ",\"fenced\":" << (sdk.busy_refusal_ ? "true" : "false")
                  << ",\"started\":" << (started ? "true" : "false")
                  << ",\"binary\":" << (mock_binary_sends - sent_before)
                  << ",\"frames\":[" << mock_text << "]}" << std::endl;
    }
}
''')
    subprocess.run(['cc', '-c', str(cjson / 'cJSON.c'), '-I', str(cjson), '-o', str(tmp_path / 'json.o')], check=True)
    binary = tmp_path / 'busy'
    subprocess.run(['c++', '-std=c++17', '-pthread', '-I', str(UNIT), '-I', str(UNIT / 'ws_stubs'),
                    '-I', str(MAIN), '-I', str(cjson), str(source),
                    str(MAIN / 'protocols/sentient_ws_protocol.cc'), str(MAIN / 'audio/demuxer/ogg_demuxer.cc'),
                    str(tmp_path / 'json.o'), *envelope_link_args(tmp_path, cjson), '-o', str(binary)], check=True)
    subprocess.run(['bun', str(UNIT / 'busy_refusal_gateway_fixture.ts'), str(binary)], check=True, timeout=20)
