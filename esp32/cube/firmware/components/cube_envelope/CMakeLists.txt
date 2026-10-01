# Standalone local IDF component; no Boost package/framework build.
set(BOOST_INCLUDE_DIRS)
foreach(module assert config container core endian intrusive json move mp11 system throw_exception)
    list(APPEND BOOST_INCLUDE_DIRS "vendor/${module}/include")
endforeach()

idf_component_register(SRCS "bounded_envelope.cc" "boost_json_core.cc"
                       INCLUDE_DIRS "include"
                       PRIV_INCLUDE_DIRS ${BOOST_INCLUDE_DIRS}
                       PRIV_REQUIRES json)
target_compile_features(${COMPONENT_LIB} PRIVATE cxx_std_17)
target_compile_definitions(${COMPONENT_LIB} PRIVATE BOOST_JSON_NO_LIB=1 BOOST_JSON_NO_SSE2=1)
