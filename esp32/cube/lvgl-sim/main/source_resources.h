#pragma once
#include "companion.h"
#include <fstream>
#include <iterator>
#include <map>
#include <string>
#include <vector>

struct SourceResources {
    std::map<std::string, std::vector<uint8_t>> buffers;
    unsigned reads = 0;
    std::string missing;
    static bool read(void* context, const char* path, const uint8_t*& data, size_t& size) {
        auto& self = *static_cast<SourceResources*>(context);
        ++self.reads;
        if (self.missing == path) return false;
        auto found = self.buffers.find(path);
        if (found == self.buffers.end()) {
            std::string relative;
            const std::string name = path;
            if (name == "/companions/cat/companion.json") relative = "companion.json";
            else if (name.compare(0, 16, "/companions/cat/") == 0) relative = "character/cat-" + name.substr(16);
            else if (name.compare(0, 4, "/ui/") == 0) relative = "character/" + name.substr(4);
            else return false;
            std::ifstream file(std::string(SENTIENT_BOARD_DIR) + "/" + relative, std::ios::binary);
            if (!file) return false;
            std::vector<uint8_t> bytes((std::istreambuf_iterator<char>(file)), {});
            found = self.buffers.emplace(name, std::move(bytes)).first;
        }
        data = found->second.data(); size = found->second.size();
        return true;
    }
    sentient::cube::ResourceReader reader() { return {this, read}; }
};
