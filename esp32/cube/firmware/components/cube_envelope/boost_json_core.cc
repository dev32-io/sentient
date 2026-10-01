// SPDX-License-Identifier: MIT
// Build wiring only. Upstream files are unmodified; list is coupled to vendor pin.
// Do not include src.hpp: its iostream initializers retain unrelated DOM/runtime.
#define BOOST_JSON_SOURCE
#include <boost/system/system_error.hpp>
#include <boost/json/impl/error.ipp>
#include <boost/json/detail/impl/default_resource.ipp>
#include <boost/json/detail/impl/stack.ipp>
#include <boost/json/detail/impl/except.ipp>
#include <boost/json/detail/charconv/impl/from_chars.ipp>
